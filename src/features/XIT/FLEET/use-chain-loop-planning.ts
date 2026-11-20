// 原生 RT 循环执行的单船规划（XIT FLEET）。与多船时间均衡的 use-chain-planning 分离：
// 循环恰好 1 艘船、不分段、不生成 ACT。核心是整闭环不动点迭代——
// 计划 → 逐段载重 → 估时（totalHours）→ 周期天数 → 计划。
// 周期只是生成时快照（估时随出发时刻漂移），运行中不做后台重算（不轮询）。
import { ref, watch, onScopeDispose } from 'vue';
import { planChainRoute } from './chain-planner';
import {
  estimateChainFlightTimes,
  type ChainFlightEstimate,
  type ChainFlightTimeInput,
} from './chain-flight-time';
import { legLoadWeight } from './native-route-plan';
import { cycleDaysFromHours, loopEligibility } from './native-route-loop';
import { shipChainCapacity, shipOriginNaturalId, shipWarehouseStock } from './chain-allocation';
import type { ChainPlannerBase, ChainPlan, ChainCapacity } from './chain-types';
import type { DispatchShip } from './utils';

export interface LoopPlanInput {
  ship: PrunApi.Ship;
  origin: string;
  bases: ChainPlannerBase[];
  capacity: ChainCapacity;
  originStock: Record<string, number>;
  purchaseStock?: Record<string, number>;
  exchangeCode?: string;
}

export interface LoopPlanResult {
  ok: boolean;
  reasons: string[];
  plan?: ChainPlan;
  cycleHours?: number;
  estimate?: ChainFlightEstimate;
  iterations: number;
  converged: boolean;
  warnings: string[];
}

const MAX_ITERATIONS = 3;
const CONVERGENCE = 0.05;

export async function computeLoopPlan(
  input: LoopPlanInput,
  estimate: (i: ChainFlightTimeInput) => Promise<ChainFlightEstimate> = estimateChainFlightTimes,
): Promise<LoopPlanResult> {
  const warnings: string[] = [];
  const pre = loopEligibility({
    shipCount: 1,
    baseCount: input.bases.length,
    distinctDestinations: new Set([input.origin, ...input.bases.map(b => b.naturalId)]).size,
    estimateOk: true,
  });
  if (!pre.ok) {
    return { ok: false, reasons: pre.reasons, iterations: 0, converged: false, warnings };
  }
  const routeBase = {
    originNaturalId: input.origin,
    capacity: input.capacity,
    bases: input.bases,
    originStock: input.originStock,
    purchaseStock: input.purchaseStock,
    exchangeCode: input.exchangeCode,
    loop: true,
  };
  let cycleDays: number | undefined;
  let prevCycleHours: number | undefined;
  let plan: ChainPlan | undefined;
  let est: ChainFlightEstimate | undefined;
  let cycleHours: number | undefined;
  let iterations = 0;
  let converged = false;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations++;
    plan = planChainRoute({ ...routeBase, cycleDays });
    if (!plan) {
      return { ok: false, reasons: ['无法生成环线计划。'], iterations, converged: false, warnings };
    }
    const stops = plan.stops.map(s => ({ naturalId: s.naturalId, planetName: s.planetName }));
    const legCount = stops.length + 1;
    const legPayloads = Array.from({ length: legCount }, (_, index) =>
      legLoadWeight(plan!, index + 1, legCount),
    );
    est = await estimate({
      ship: input.ship,
      origin: input.origin,
      stops,
      legPayloads,
      refuelAtOrigin: true,
    });
    // 任一段判缺 ⇒ 得不到可靠周期，退回单趟（不进入循环模式）。
    if (!est.ok) {
      return {
        ok: false,
        reasons: ['飞行估时不完整，无法确定循环周期。'],
        plan,
        estimate: est,
        iterations,
        converged: false,
        warnings,
      };
    }
    cycleHours = est.totalHours;
    if (
      prevCycleHours !== undefined &&
      cycleHours > 0 &&
      Math.abs(cycleHours - prevCycleHours) / cycleHours < CONVERGENCE
    ) {
      converged = true;
      break;
    }
    prevCycleHours = cycleHours;
    cycleDays = cycleDaysFromHours(cycleHours);
  }
  if (!converged) {
    warnings.push('循环周期迭代未收敛（3 次），保留最后一次估算（界面标「预计」）。');
  }
  return {
    ok: true,
    reasons: [],
    plan,
    cycleHours,
    estimate: est,
    iterations,
    converged,
    warnings,
  };
}

// 单船循环规划的响应式封装：enabled/船/基地变化时重算闭环迭代。
export function useChainLoopPlanning(input: {
  ship: () => DispatchShip | undefined;
  bases: () => ChainPlannerBase[];
  enabled: () => boolean;
}) {
  const result = ref<LoopPlanResult | undefined>(undefined);
  const computing = ref(false);
  // 循环为什么没结果（资格/缺载重/估时抛错）：界面横幅要能说清楚，不能留空条。
  const error = ref<string>();
  let token = 0;
  async function recompute() {
    const current = ++token;
    const ship = input.ship();
    const bases = input.bases();
    if (!input.enabled() || ship === undefined || bases.length === 0) {
      error.value = undefined;
      result.value = undefined;
      computing.value = false;
      return;
    }
    const capacity = shipChainCapacity(ship);
    if (capacity === undefined) {
      error.value = '该船缺少载重数据，无法估算循环周期。';
      result.value = undefined;
      computing.value = false;
      return;
    }
    error.value = undefined;
    computing.value = true;
    try {
      const next = await computeLoopPlan({
        ship: ship.ship,
        origin: shipOriginNaturalId(ship),
        bases,
        capacity,
        originStock: shipWarehouseStock(ship) ?? {},
        exchangeCode: ship.exchangeCode,
      });
      if (current === token) {
        result.value = next;
      }
    } catch (e) {
      console.warn('[XIT/FLEET] loop plan failed', e);
      if (current === token) {
        error.value = `循环估算失败：${e instanceof Error ? e.message : String(e)}`;
        result.value = undefined;
      }
    } finally {
      if (current === token) {
        computing.value = false;
      }
    }
  }
  watch([() => input.enabled(), () => input.ship(), () => input.bases()], () => void recompute(), {
    immediate: true,
    deep: true,
  });
  onScopeDispose(() => {
    token++;
  });
  return { result, computing, error, recompute };
}
