import type { ChainPlan } from './chain-types';

export const DEFAULT_WAYPOINT_FUEL_PERCENT = 25;

export type RouteTank = 'STL' | 'FTL';

type NativeRouteMaterialStep = {
  kind: 'load' | 'unload';
  ticker: string;
  amount: number;
  minimum?: 0;
  capacity?: true;
};

export type NativeRouteEditableStep =
  | NativeRouteMaterialStep
  // `limited` = 游戏里把补油量改成了固定数量（`minimum/maximum: ABSOLUTE`）。缺省表示补满
  // （`CAPACITY`，RPrun 写入的就是这个），也只有补满才能当作「出发油量与上游无关」的边界。
  | { kind: 'refuel'; tank: RouteTank; limited?: true };

export type NativeRouteStep =
  NativeRouteEditableStep | { kind: 'unload-all'; planned?: NativeRouteMaterialStep[] };

export interface NativeWaypoint {
  location: string;
  steps: NativeRouteStep[];
}

export function withOriginRefuels(
  waypoints: readonly NativeWaypoint[],
  tanks: readonly RouteTank[] = ['STL', 'FTL'],
): NativeWaypoint[] {
  return waypoints.map((stop, index) =>
    index === 0
      ? {
          ...stop,
          steps: [
            ...stop.steps.filter(step => step.kind !== 'load'),
            ...tanks.map(tank => ({ kind: 'refuel' as const, tank })),
            ...stop.steps.filter(step => step.kind === 'load'),
          ],
        }
      : stop,
  );
}

export interface NativeRouteLegPercent {
  fuelPercent: number;
  reactorPercent?: number;
  hours?: number;
}

export function nativeFormulaLeg(option: {
  fuel: number;
  reactor: number;
  reactorRelevant: boolean;
  totalHours: number;
}): NativeRouteLegPercent {
  return {
    fuelPercent: Math.round(option.fuel * 100),
    reactorPercent: option.reactorRelevant ? Math.round(option.reactor * 100) : undefined,
    hours: option.totalHours,
  };
}

// 航点的燃料消耗与反应堆使用量都是 1–100% 的整数档。
export function isWaypointPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

// 把 0–1 的系数换成游戏写入用的整数百分比，并保证不低于最小值——**向上**取整：
// 蓝图下限 0.653 若四舍五入成 65%，写进航线的就低于下限，自然跃迁段会飞不动。
export function percentAtLeast(value: number, minimum = 0) {
  const percent = Math.ceil(Math.max(value, minimum) * 100 - 1e-9);
  return Math.min(100, Math.max(1, percent));
}

export function buildNativeWaypoints(plan: ChainPlan, startsWithEmptyCargo = false, loop = false) {
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
  const returnSteps = materialSteps('unload', plan.finalUnload);
  // 首次到达仓库时尚未从基地取货，卸货步骤必须能在空舱时完成。
  waypoints.push({
    location: origin,
    steps: loop ? returnSteps.map(step => ({ ...step, minimum: 0 as const })) : returnSteps,
  });
  for (const [index, waypoint] of waypoints.entries()) {
    const from = waypoints[index - 1]?.location;
    if (!waypoint.location.trim() || waypoint.location === from) {
      throw new Error('航线包含空地址或连续重复的航点。');
    }
  }
  const route = startsWithEmptyCargo ? withFullUnloads(waypoints) : waypoints;
  if (loop) {
    const first = route[0]!;
    first.steps = [...route.pop()!.steps, ...first.steps];
  }
  return route;
}

function withFullUnloads(waypoints: NativeWaypoint[]): NativeWaypoint[] {
  const cargo = new Map<string, number>();
  const result: NativeWaypoint[] = [];
  for (const waypoint of waypoints) {
    const planned = waypoint.steps.filter(
      (step): step is NativeRouteMaterialStep => step.kind === 'unload',
    );
    const clearsCargo =
      planned.length > 0 &&
      planned.length === cargo.size &&
      planned.every(step => cargo.get(step.ticker) === step.amount);
    for (const step of waypoint.steps) {
      if (step.kind !== 'load' && step.kind !== 'unload') {
        continue;
      }
      const amount =
        (cargo.get(step.ticker) ?? 0) + (step.kind === 'load' ? step.amount : -step.amount);
      if (amount < 0 || !Number.isSafeInteger(amount)) {
        return waypoints;
      }
      if (amount === 0) {
        cargo.delete(step.ticker);
      } else {
        cargo.set(step.ticker, amount);
      }
    }
    result.push({
      ...waypoint,
      steps: clearsCargo
        ? [
            { kind: 'unload-all', planned },
            ...waypoint.steps.filter(step => step.kind !== 'unload'),
          ]
        : waypoint.steps,
    });
  }
  return result;
}

// 原生界面回退沿用已支持的逐项装卸编辑器。
export function editableNativeSteps(steps: readonly NativeRouteStep[]): NativeRouteEditableStep[] {
  return steps.flatMap<NativeRouteEditableStep>(step =>
    step.kind === 'unload-all' ? (step.planned ?? []) : [step],
  );
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
  refills: (step: NativeRouteStep) => boolean = step => step.kind === 'refuel',
  loop = false,
): number[] {
  const stale: number[] = [];
  const pending = new Set(tanksAffected);
  const end = loop ? fromIndex + count : count;
  for (let index = fromIndex; index < end && pending.size > 0; index++) {
    const k = index % count;
    stale.push(k);
    // 航点 k 的补油步骤在飞往 k+1 之前执行。
    for (const step of waypoints[k]?.steps ?? []) {
      if (step.kind === 'refuel' && refills(step)) {
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

function materialSteps(
  kind: 'load' | 'unload',
  bill: Record<string, number>,
): NativeRouteMaterialStep[] {
  return Object.entries(bill).flatMap(([ticker, amount]) => {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`${ticker} 的货量无法写入原生 RT。`);
    }
    return amount === 0 ? [] : [{ kind, ticker, amount }];
  });
}
