import { blueprintInfoFor, shipFuelRemainingFor } from '@src/features/XIT/FTC/ftc-compute';
import { planFormulaFlight } from '@src/features/XIT/FTC/formula-plan';
import type { ShipChainPlan } from './chain-allocation';
import { measureNativeRouteFuel } from './native-route-btf';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  legLoadWeight,
  nativeFormulaLeg,
  type NativeRouteLegPercent,
  type NativeWaypoint,
} from './native-route-plan';

export interface NativeRouteFuelPlan {
  // 与 waypoints 等长：首站没有入站航段，保留默认值且不写反应堆。
  legs: NativeRouteLegPercent[];
  // 未算出、最终兜底默认值的航段逐个说明。
  warnings: string[];
}

// 每段优先在 FTC 公式算出的可行整数档位中选性价比。确认缺油时停止生成；
// 缺轨道、环境或星图数据时改用 BTF 实测。
// 载重按该段离站时的计划舱载补进模型质量：规划期飞船通常还没装货，而质量既影响转移段速度
// 也影响着陆/起飞燃料。
export async function computeNativeRouteFuel(
  candidate: ShipChainPlan,
  waypoints: readonly NativeWaypoint[],
  signal: AbortSignal,
  onProgress: (status: string) => void,
): Promise<NativeRouteFuelPlan> {
  const ship = candidate.ship.ship;
  const registration = ship.registration;
  const legCount = waypoints.length - 1;
  const info = blueprintInfoFor(ship);
  const fuelNow = shipFuelRemainingFor(ship);
  const stlCap = fuelNow.stlCap > 0 ? fuelNow.stlCap : info?.stlFuelCapacity;
  const ftlCap = fuelNow.ftlCap > 0 ? fuelNow.ftlCap : undefined;
  // 出发油量：有补油步骤时出发前会补满，否则用当前余量；后续航段按上一段实耗递减，
  // 只有真正存在补油步骤的航点才重置为罐容量（规划器只在出发地写补油）。
  // 油罐已读出（容量已知）时余量 0 就是真空罐，必须原样保留——改成 undefined 会被
  // 下游当成「读不到」而回退成满罐；只有容量也读不到（store 未加载）才算未知。
  let stlFuel = fuelNow.stlCap > 0 ? fuelNow.stlRemaining : undefined;
  let ftlFuel = fuelNow.ftlCap > 0 ? fuelNow.ftlRemaining : undefined;
  const refuels = (waypointIndex: number, tank: 'STL' | 'FTL') =>
    waypoints[waypointIndex]?.steps.some(x => x.kind === 'refuel' && x.tank === tank) ?? false;
  const applyRefuel = (waypointIndex: number) => {
    if (refuels(waypointIndex, 'STL')) {
      stlFuel = stlCap;
    }
    if (refuels(waypointIndex, 'FTL')) {
      ftlFuel = ftlCap;
    }
  };
  const consume = (used: { stlFuel?: number; ftlFuel?: number }) => {
    if (stlFuel !== undefined && typeof used.stlFuel === 'number') {
      stlFuel = Math.max(0, stlFuel - used.stlFuel);
    }
    if (ftlFuel !== undefined && typeof used.ftlFuel === 'number') {
      ftlFuel = Math.max(0, ftlFuel - used.ftlFuel);
    }
  };
  // 出发余量不够这一段就飞不完：模型只给油耗、不校验油量，航线写下去会中途停下。
  // 只在「已知余量」时判断（油罐读不出来时无话可说），不阻止写入。
  const reportShortfall = (index: number, used: { stlFuel?: number; ftlFuel?: number }) => {
    const route = `${waypoints[index - 1]!.location} → ${waypoints[index]!.location}`;
    const tanks = [
      { tank: 'STL', balance: stlFuel, need: used.stlFuel },
      { tank: 'FTL', balance: ftlFuel, need: used.ftlFuel },
    ] as const;
    for (const { tank, balance, need } of tanks) {
      if (balance === undefined || typeof need !== 'number' || need <= balance + 1e-6) {
        continue;
      }
      warnings.push(
        `${route}：${tank} 不够（本段需 ${Math.ceil(need)}，出发只有 ${Math.round(balance)}），` +
          '航线会中途停下——在游戏里给该站加补油，或降低这一段的档位。',
      );
    }
  };
  const legs = waypoints.map<NativeRouteLegPercent>(() => ({
    fuelPercent: DEFAULT_WAYPOINT_FUEL_PERCENT,
  }));
  const warnings: string[] = [];
  for (let index = 1; index <= legCount; index++) {
    signal.throwIfAborted();
    const from = waypoints[index - 1]!.location;
    const to = waypoints[index]!.location;
    // 航点 index-1 的补油步骤在飞往 index 之前执行。
    applyRefuel(index - 1);
    onProgress(`FTC ${registration} · ${index}/${legCount} · ${from} → ${to}`);
    const result = await planFormulaFlight({
      ship,
      from,
      to,
      useGateway: true,
      // 规划载重 + 未来出发油量。
      payload: legLoadWeight(candidate.plan, index, legCount),
      stlFuel,
      // 与 STL 一样逐段递推 FTL 余量：不传会让模型每次回读当前油箱，
      // 出发地补满或上一段消耗后的余量都对不上。
      ...(ftlFuel === undefined ? {} : { ftlFuel }),
      selection: 'value',
    });
    if (result.ok && result.best !== undefined) {
      legs[index] = nativeFormulaLeg(result.best);
      consume(result.best);
      continue;
    }
    if (result.insufficientFuel) {
      throw new Error(`${from} → ${to}：${result.message}`);
    }
    if (result.inputIncomplete === undefined || result.inputIncomplete.length === 0) {
      // 不是「缺输入」而是公式计算失败：别用 BTF 试飞去掩盖一个代码 bug。
      warnings.push(`FTC 计算失败 ${from} → ${to}：${result.message}`);
      warnings.push(
        `${from} → ${to} 的燃料消耗保留 ${DEFAULT_WAYPOINT_FUEL_PERCENT}%（公式模型失败）。`,
      );
      continue;
    }
    warnings.push(`FTC 跳过 ${from} → ${to}：${skipReason(result)}`);
    // 该段缺模型输入：用 BTF 试飞实测，油量用当前航段出发时的剩余量。
    try {
      const measured = await measureNativeRouteFuel(
        candidate,
        waypoints,
        [index],
        signal,
        onProgress,
        { stlFuel, ftlFuel },
      );
      warnings.push(...measured.warnings);
      const leg = measured.legs.get(index);
      if (leg !== undefined) {
        legs[index] = {
          fuelPercent: clampPercent(leg.fuel),
          reactorPercent: leg.reactor === undefined ? undefined : clampPercent(leg.reactor),
          hours: leg.hours,
        };
        reportShortfall(index, leg);
        consume(leg);
        continue;
      }
    } catch (err) {
      if (signal.aborted) {
        throw err;
      }
      warnings.push(
        `BTF 试飞未完成（${err instanceof Error ? err.message : String(err)}）：${from} → ${to}。`,
      );
    }
    // 试飞也没算出来：该段保留游戏默认档（新模型已不依赖原生几何，没有第三条估算路径）。
    warnings.push(
      `${from} → ${to} 的燃料消耗保留 ${DEFAULT_WAYPOINT_FUEL_PERCENT}%（试飞与模型计算都不可用）。`,
    );
  }
  return { legs, warnings };
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(1, Math.round(value)));
}

// 压缩成一行原因：缺少的模型输入只取条目名（冒号前），完整成因留在 FTC 面板。
function skipReason(result: { message: string; inputIncomplete?: string[] }) {
  const items = result.inputIncomplete;
  if (items === undefined || items.length === 0) {
    return result.message;
  }
  return items.map(x => x.split('：')[0]!.trim()).join('、');
}
