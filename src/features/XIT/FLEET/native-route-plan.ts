import type { ChainPlan } from './chain-types';

export const DEFAULT_WAYPOINT_FUEL_PERCENT = 25;

export type RouteTank = 'STL' | 'FTL';

export type NativeRouteStep =
  { kind: 'load' | 'unload'; ticker: string; amount: number } | { kind: 'refuel'; tank: RouteTank };

export interface NativeWaypoint {
  location: string;
  steps: NativeRouteStep[];
}

export function isWaypointFuelPercent(value: unknown): value is number {
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

function materialSteps(kind: 'load' | 'unload', bill: Record<string, number>): NativeRouteStep[] {
  return Object.entries(bill).flatMap(([ticker, amount]) => {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`${ticker} 的货量无法写入原生 RT。`);
    }
    return amount === 0 ? [] : [{ kind, ticker, amount }];
  });
}
