import { blueprintInfoFor, shipFuelRemainingFor } from '@src/features/XIT/FTC/ftc-compute';
import { planFormulaFlight } from '@src/features/XIT/FTC/formula-plan';
import type { ShipChainPlan } from './chain-allocation';
import { measureNativeRouteFuel } from './native-route-btf';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  legLoadWeight,
  percentAtLeast,
  type NativeWaypoint,
} from './native-route-plan';

// 航点编辑器的两个百分比档位。反应堆使用量只在存在自然跃迁时写（全程系内/纯网关飞行
// 反应堆不影响时长与燃料，保持游戏默认）。
export interface NativeRouteLegPercent {
  fuelPercent: number;
  reactorPercent?: number;
  // 该档位下的预计飞行时长（小时）：FTC 选点结果或 BTF 试飞实测顺带带回。
  hours?: number;
}

export interface NativeRouteFuelPlan {
  // 与 waypoints 等长：首站没有入站航段，保留默认值且不写反应堆。
  legs: NativeRouteLegPercent[];
  // 未算出、最终兜底默认值的航段逐个说明。
  warnings: string[];
}

// 每段燃料消耗百分比优先用公式模型算（全档扫描 + 最优性价比选点，与 FTC 面板同一模块；
// planFormulaFlight 只算不写，没有共享参数副作用）；模型算不出来（航线不可达、缺轨道/环境/星图）
// 时改用 BTF 实测。
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
  const stlCap = fuelNow.stlCap > 0 ? fuelNow.stlCap : (info?.stlFuelCapacity ?? 0);
  const ftlCap = fuelNow.ftlCap > 0 ? fuelNow.ftlCap : undefined;
  const minReactorUsage = info?.minReactorUsage ?? 0;
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
  // 选中档位按整数百分比写入；写入用的反应堆档被取整抬高时（例如下限 0.653 写成 66%），
  // 时长与油耗属于旧档位，必须按**实际写入的档位**重算，否则后续航段按旧档位扣油。
  const applyWrittenTiers = async (
    index: number,
    option: { fuel: number; reactor: number; totalHours: number; stlFuel: number; ftlFuel: number },
    reactorRelevant: boolean,
  ) => {
    const fuelPercent = clampPercent(option.fuel * 100);
    // 写入用的整数百分比必须仍然满足蓝图下限（向下取整会写出跑不动的档位）。
    const reactorPercent = reactorRelevant
      ? percentAtLeast(option.reactor, minReactorUsage)
      : undefined;
    const reactorChanged =
      reactorPercent !== undefined && Math.abs(reactorPercent - option.reactor * 100) > 1e-6;
    if (!reactorChanged) {
      return {
        fuelPercent,
        reactorPercent,
        hours: option.totalHours as number | undefined,
        stlFuel: option.stlFuel,
        ftlFuel: option.ftlFuel,
      };
    }
    const recalculated = await planFormulaFlight({
      ship,
      from: waypoints[index - 1]!.location,
      to: waypoints[index]!.location,
      useGateway: true,
      // 规划载重 + 未来出发油量 + 实际写入的固定档。
      payload: legLoadWeight(candidate.plan, index, legCount),
      stlFuel,
      // 用**写入的那个档位**重算，避免重算结果与实际航线不一致。
      fuel: fuelPercent / 100,
      reactor: reactorPercent === undefined ? undefined : reactorPercent / 100,
      selection: 'value',
    });
    if (recalculated.ok && recalculated.best !== undefined) {
      return {
        fuelPercent,
        reactorPercent,
        hours: recalculated.best.totalHours,
        stlFuel: recalculated.best.stlFuel,
        ftlFuel: recalculated.best.ftlFuel,
      };
    }
    // 重算失败：保守按原（更费油）消耗续算，该段时长不再展示。
    return {
      fuelPercent,
      reactorPercent,
      hours: undefined as number | undefined,
      stlFuel: option.stlFuel,
      ftlFuel: option.ftlFuel,
    };
  };
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
      selection: 'value',
    });
    if (result.ok && result.best !== undefined) {
      const chosen = await applyWrittenTiers(index, result.best, result.reactorRelevant);
      legs[index] = {
        fuelPercent: chosen.fuelPercent,
        reactorPercent: chosen.reactorPercent,
        hours: chosen.hours,
      };
      reportShortfall(index, chosen);
      consume(chosen);
      continue;
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
