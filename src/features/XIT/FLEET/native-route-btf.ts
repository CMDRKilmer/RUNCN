import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import {
  calculateTestFlight,
  encodeAddress,
  resolveEntity,
} from '@src/infrastructure/prun-api/data/flight-test-collector';
import {
  ensureShipBlueprint,
  shipFuelRemainingFor,
  shipPerformanceFor,
} from '@src/features/XIT/FTC/ftc-compute';
import {
  autoFuelGrid,
  conditionFactor,
  pickBestValueOption,
  stlDepartureFuelCapPercent,
  type FuelTradeoff,
} from '@src/features/XIT/FTC/fuel-model';
import { summarizeNativeFlightPlan } from '@src/features/XIT/FTC/route-planner';
import { sleep } from '@src/utils/sleep';
import type { ShipChainPlan } from './chain-allocation';
import { legLoadWeight, type NativeWaypoint } from './native-route-plan';
import { recordTransitSpeedSample } from './transit-speed-samples';

// 从游戏滑块的最小档 5% 扫到 100%（1% 会被服务器拒绝，白跑一趟）。
const fuelPercents = autoFuelGrid().map(fuel => Math.round(fuel * 100));
// 试飞默认 50% 反应堆使用量（与旧 BTF 面板口径一致）；蓝图下限更高时用下限。
const DEFAULT_REACTOR_USAGE = 0.5;
// 服务器限速礼貌间隔（与 transit-f-scan 的批量采集一致）。
const REQUEST_INTERVAL_MS = 250;

// 性价比选点：扫完整档位（5%–100%）后逐档比较「多烧的燃料换回多少时间」，
// 边际收益跌破首档一半就停（`pickBestValueOption`）——临近饱和段速度提升很小、
// 燃料却继续涨，扫完才能看清整条曲线，所以这里不做提前停止。

function chooseSample(samples: readonly FuelTradeoff[], maxFuel: number | undefined) {
  return pickBestValueOption([...samples], maxFuel);
}

// 把试飞响应里的 TRANSIT 段转成 FTC 转移速度查询表的样本（q, aEff, v）：
// 远端表只覆盖少数 aEff 行，采到该船自己的 aEff 行后，同船后续的 FTC 计算就不再判「超出可靠范围」。
// 质量口径与 computeFtcPlan 一致：`perf.mass` 就是当前船质量（已含船上现有货物），
// 这里只叠加**计划新增载重**；payload 里为了让服务器算对试飞而加的现有货物不能重复算。
function recordTransitSpeedSamples(
  performance: ReturnType<typeof shipPerformanceFor>,
  ship: PrunApi.Ship,
  addedMass: number,
  tank: number,
  fuelPercent: number,
  plan: PrunApi.FlightPlan,
) {
  const engine = performance.stlEngineOption;
  if (engine === undefined || !(tank > 0)) {
    return;
  }
  const mass = (ship.mass > 0 ? ship.mass : ship.operatingEmptyMass) + addedMass;
  if (!(mass > 0) || !(ship.operatingEmptyMass > 0) || !(ship.acceleration > 0)) {
    return;
  }
  const aEff = (ship.acceleration * ship.operatingEmptyMass) / mass;
  const q = 0.98 * tank * Math.min(fuelPercent / 100, 0.5);
  // 服务器试飞的速度已经含船况惩罚；查询表存健康船速度（模型在算时长时才乘
  // conditionFactor），否则后续估算会把船况惩罚重复计算两次。
  const cond = conditionFactor(ship.condition);
  for (const segment of plan.segments) {
    if (segment.type !== 'TRANSIT' || segment.stlDistance === null) {
      continue;
    }
    const seconds = (segment.arrival.timestamp - segment.departure.timestamp) / 1000;
    // 太短的段相对噪声大（秒级抖动就有百分之几误差），不进表。
    if (!(seconds >= 60) || !(segment.stlDistance > 1000)) {
      continue;
    }
    recordTransitSpeedSample(engine, q, aEff, (segment.stlDistance / seconds) * cond);
  }
}

export interface BtfLegFuel {
  // 实测平衡点的燃料消耗百分比。
  fuel: number;
  // 试飞时实际使用的反应堆使用量。
  reactor?: number;
  // 该档位下服务器试飞的总时长（小时），供 FLEET「飞行」列直接展示。
  hours: number;
  // 该档位消耗的 STL/FTL 燃料（用于后续航段递减油量）。
  stlFuel: number;
  ftlFuel: number;
}

export interface BtfFuelResult {
  // 段序号（1 起）→ 实测档位。
  legs: Map<number, BtfLegFuel>;
  // 单段失败原因。
  warnings: string[];
}

// 缺服务器原生记录的航段改用 BTF 实测：直接走 socket 发 SHIP_FLIGHT_CALCULATE_TEST_FLIGHT
// （与 BTF 面板同一个服务器计算），不开窗口、不碰滑块——载重/燃料/反应堆都是请求参数。
// 每档一次请求，边际收益耗尽即停；响应里的 SHIP_FLIGHT_MISSION 还会自动写入原生 STL 段记录。
export async function measureNativeRouteFuel(
  candidate: ShipChainPlan,
  waypoints: readonly NativeWaypoint[],
  legs: readonly number[],
  signal: AbortSignal,
  onProgress: (status: string) => void,
  // 起飞油量：多段航线的后续段要用上一段剩下的油（不补油时），缺省按罐容量。
  fuel?: { stlFuel?: number; ftlFuel?: number },
): Promise<BtfFuelResult> {
  const ship = candidate.ship.ship;
  signal.throwIfAborted();
  await ensureShipBlueprint(ship);
  const blueprint = blueprintsStore.getByNaturalId(ship.blueprintNaturalId);
  if (blueprint === undefined) {
    throw new Error(`未获取到蓝图 ${ship.blueprintNaturalId}，无法试飞。`);
  }
  // 试飞的油量基准默认用「罐容量」：航线在出发地补满时每段都是满罐起飞；
  // 但多段之间没有补油时由调用方传入当前剩余油量。
  const performance = shipPerformanceFor(ship);
  const fuelNow = shipFuelRemainingFor(ship);
  const stlFuel =
    fuel?.stlFuel !== undefined
      ? fuel.stlFuel
      : fuelNow.stlCap > 0
        ? fuelNow.stlCap
        : (performance.stlFuelCapacity ?? 0);
  const ftlFuel =
    fuel?.ftlFuel !== undefined
      ? fuel.ftlFuel
      : fuelNow.ftlCap > 0
        ? fuelNow.ftlCap
        : fuelNow.ftlRemaining;
  // 反应堆使用量：默认 50%，但不能低于蓝图下限（高下限船会直接拒绝低反应堆的计划）。
  const reactorUsage = Math.min(
    1,
    Math.max(DEFAULT_REACTOR_USAGE, performance.minReactorUsage ?? 0),
  );
  const reactorPercent = Math.round(reactorUsage * 100);
  // 档位上限：离港燃料饱和点（10.96×STL 流量），超过它只会多烧油。
  const capPercent = stlDepartureFuelCapPercent(performance.stlFuelFlowRate);
  const legCount = waypoints.length - 1;
  const codes = new Map<string, string>();
  const measured = new Map<number, BtfLegFuel>();
  const warnings: string[] = [];

  const addressCode = async (location: string) => {
    const key = location.trim().toUpperCase();
    const cached = codes.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const address = await resolveEntity(location);
    const code = address === undefined ? undefined : encodeAddress(address);
    if (code === undefined) {
      throw new Error(`无法解析 ${location} 的地址。`);
    }
    codes.set(key, code);
    return code;
  };

  for (const index of legs) {
    const from = waypoints[index - 1]!.location;
    const to = waypoints[index]!.location;
    try {
      signal.throwIfAborted();
      const origin = await addressCode(from);
      const destination = await addressCode(to);
      // 载重 = 计划舱载 + 船上现有货物：规划器的 loadOnDeparture 从空舱起算
      // （现有货物只用来压减可用舱容），而服务器试飞只认 payload 参数。
      const plannedLoad = Math.ceil(legLoadWeight(candidate.plan, index, legCount));
      const payload = plannedLoad + (candidate.ship.cargoStore?.weightLoad ?? 0);
      const samples: FuelTradeoff[] = [];
      let timeouts = 0;
      let rejected = 0;
      for (const percent of fuelPercents) {
        signal.throwIfAborted();
        onProgress(
          `BTF ${ship.blueprintNaturalId} · ${index}/${legCount} · ${from} → ${to} · ${percent}%`,
        );
        const plan = await calculateTestFlight(origin, destination, blueprint.id, 15000, {
          fuelUsageFactor: percent / 100,
          payload,
          condition: ship.condition,
          stlFuel,
          ftlFuel,
          reactorUsageFactor: reactorUsage,
          landing: true,
          // 与游戏自己写入航点时的默认偏好一致（实采 SHIP_ROUTES_EDIT_WAYPOINT：
          // ftlPreference LEAST_JUMPS、useGateways true）——试飞要走和航线一样的路线。
          preferences: { ftlPreference: 'LEAST_JUMPS', useGateways: true },
        });
        if (plan === undefined) {
          timeouts++;
          continue;
        }
        if (plan.status === 'OK') {
          const summary = summarizeNativeFlightPlan(plan);
          recordTransitSpeedSamples(performance, ship, plannedLoad, stlFuel, percent, plan);
          if (summary.totalSeconds > 0) {
            samples.push({
              fuel: percent,
              reactor: reactorPercent,
              totalHours: summary.totalSeconds / 3600,
              stlFuel: summary.stlFuel,
              ftlFuel: summary.ftlFuel,
            });
          }
        } else {
          rejected++;
        }
        await sleep(REQUEST_INTERVAL_MS);
      }
      if (timeouts > 0) {
        warnings.push(`${from} → ${to}：${timeouts} 档试飞无响应（已跳过）。`);
      }
      if (rejected > 0) {
        warnings.push(`${from} → ${to}：${rejected} 档试飞被服务器拒绝（不影响已测档位）。`);
      }
      const best = chooseSample(samples, capPercent);
      if (best === undefined) {
        throw new Error('试飞没有可用方案。');
      }
      measured.set(index, {
        fuel: best.fuel,
        reactor: reactorPercent,
        hours: best.totalHours,
        stlFuel: best.stlFuel,
        ftlFuel: best.ftlFuel,
      });
    } catch (err) {
      if (signal.aborted) {
        throw err;
      }
      warnings.push(`${from} → ${to}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { legs: measured, warnings };
}
