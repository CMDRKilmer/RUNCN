import type { ChainPlan } from './chain-types';

export const DEFAULT_WAYPOINT_FUEL_PERCENT = 25;

export type RouteTank = 'STL' | 'FTL';

export type NativeRouteStep =
  | { kind: 'load' | 'unload'; ticker: string; amount: number; capacity?: true }
  | { kind: 'refuel'; tank: RouteTank };

export interface NativeWaypoint {
  location: string;
  steps: NativeRouteStep[];
}

// 航点的燃料消耗与反应堆使用量都是 1–100% 的整数档。
export function isWaypointPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

export function buildNativeWaypoints(plan: ChainPlan) {
  if (plan.stops.length === 0 || plan.overCapacity || plan.hasUnmetChainDemand === true) {
    throw new Error('环线缺少可执行站点、超出舱容或有未满足的产业链需求。');
  }
  const origin = plan.originNaturalId;
  const waypoints: NativeWaypoint[] = [
    {
      location: origin,
      steps: materialSteps('load', plan.cxBill),
    },
  ];
  for (const stop of plan.stops) {
    const unload = { ...stop.unloadCx };
    for (const [ticker, cargo] of stop.unloadChain) {
      unload[ticker] = (unload[ticker] ?? 0) + cargo.amount;
    }
    const load = Object.fromEntries(
      [...stop.load].map(([ticker, cargo]) => [ticker, cargo.amount]),
    );
    waypoints.push({
      location: stop.naturalId,
      steps: [...materialSteps('unload', unload), ...materialSteps('load', load)],
    });
  }
  waypoints.push({ location: origin, steps: materialSteps('unload', plan.finalUnload) });
  for (const [index, waypoint] of waypoints.entries()) {
    const from = waypoints[index - 1]?.location;
    if (!waypoint.location.trim() || waypoint.location === from) {
      throw new Error('航线包含空地址或连续重复的航点。');
    }
  }
  return waypoints;
}

// 改了 fromIndex 段的档位后，需要作废时长的航段下标：本段必然失效；中途不补油时
// 后续段的出发余量随该段消耗一起变，也一并作废，直到受影响的油罐在某航点补满
// （补满后出发余量与上游消耗脱钩）。燃料档只影响 STL 消耗、反应堆档只影响 FTL 消耗
// （FTL 燃料 = 系数 × 反应堆档 × 距离）。
export function hoursInvalidatedBySettingChange(
  waypoints: readonly NativeWaypoint[],
  fromIndex: number,
  count: number,
  tanksAffected: readonly RouteTank[],
): number[] {
  const stale: number[] = [];
  const pending = new Set(tanksAffected);
  for (let k = fromIndex; k < count && pending.size > 0; k++) {
    stale.push(k);
    // 航点 k 的补油步骤在飞往 k+1 之前执行。
    for (const step of waypoints[k]?.steps ?? []) {
      if (step.kind === 'refuel') {
        pending.delete(step.tank);
      }
    }
  }
  return stale;
}

// 第 index 段（1 起，共 legCount 段）离站时的计划舱载（t）：出发地装载 / 各站离站舱载 /
// 归航舱载。只含计划新增货物——船上现有货物不在规划里（它只压减可用舱容），
// 需要完整离站重量时由调用方叠加 `cargoStore.weightLoad`。
// FTC 模型按它补质量（规划期飞船通常还没装货）。
export function legLoadWeight(plan: ChainPlan, index: number, legCount: number) {
  if (index === 1) {
    return plan.loadOnDeparture.weight;
  }
  if (index === legCount) {
    return plan.loadOnReturn.weight;
  }
  return plan.stops[index - 2]?.loadOnDeparture.weight ?? 0;
}

function materialSteps(kind: 'load' | 'unload', bill: Record<string, number>): NativeRouteStep[] {
  return Object.entries(bill).flatMap(([ticker, amount]) => {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`${ticker} 的货量无法写入原生 RT。`);
    }
    return amount === 0 ? [] : [{ kind, ticker, amount }];
  });
}
