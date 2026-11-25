// 原生 RT 循环执行的单船规划（XIT FLEET）。与多船时间均衡的 use-chain-planning 分离：
// 循环恰好 1 艘船、不分段、不生成 ACT。核心是整闭环不动点迭代——
// 计划 → 逐段载重 → 估时（totalHours）→ 周期天数 → 核对整数装卸量。
// 周期只是生成时快照（估时随出发时刻漂移），运行中不做后台重算（不轮询）。
import { ref, watch, onScopeDispose } from 'vue';
import { collectChainPlanningSnapshot, loopBurnBill } from './chain-data';
import { computeChainPlan, type ChainPlanningSnapshot } from './chain-plan-core';
import {
  estimateChainFlightTimes,
  type ChainFlightEstimate,
  type ChainFlightTimeInput,
} from './chain-flight-time';
import { legLoadWeight } from './native-route-plan';
import { cycleDaysFromHours, cycleNetAmount, loopEligibility } from './native-route-loop';
import { shipChainCapacity, shipOriginNaturalId } from './chain-allocation';
import type { ChainPlannerBase, ChainPlan, ChainCapacity } from './chain-types';
import type { DispatchShip } from './utils';
import { gameNow } from '@src/infrastructure/fio/orbit';
import { fixed0, fixed02 } from '@src/utils/format';

export interface LoopPlanInput {
  ship: PrunApi.Ship;
  origin: string;
  bases: ChainPlannerBase[];
  capacity: ChainCapacity;
}

export interface LoopPlanResult {
  ok: boolean;
  reasons: string[];
  plan?: ChainPlan;
  cycleHours?: number;
  estimate?: ChainFlightEstimate;
  iterations: number;
  converged: boolean;
}

const MAX_ITERATIONS = 8;

function transferSignature(plan: ChainPlan) {
  const quantities = (items: Iterable<[string, number]>) =>
    [...items].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    quantities(Object.entries(plan.cxBill)),
    plan.stops.map(stop => [
      stop.naturalId,
      quantities(Object.entries(stop.unloadCx)),
      quantities(Array.from(stop.unloadChain, ([ticker, item]) => [ticker, item.amount])),
      quantities(Array.from(stop.load, ([ticker, item]) => [ticker, item.amount])),
    ]),
    quantities(Object.entries(plan.finalUnload)),
  ]);
}

function validateLoopTransfers(plan: ChainPlan, snapshot: ChainPlanningSnapshot, days: number) {
  const reasons: string[] = [];
  if (plan.stops.length === 0) {
    reasons.push('该周期内没有可执行的基地装卸。');
  }
  if (plan.overCapacity) {
    reasons.push('出发地的每轮必需补给超过飞船剩余舱容。');
  }
  for (const [ticker, amount] of Object.entries(plan.loopOriginReturn ?? {})) {
    const missing = amount - (plan.finalUnload[ticker] ?? 0);
    if (missing > 0) {
      reasons.push(`出发地「${ticker}」每轮少回运 ${fixed0(missing)}，产量或舱容不足。`);
    }
  }
  const stops = new Map(plan.stops.map(stop => [stop.naturalId, stop]));
  const missingDimensions = new Set<string>();
  for (const base of snapshot.bases) {
    const stop = stops.get(base.naturalId);
    for (const [ticker, rate] of Object.entries(base.burn)) {
      const unload = (stop?.unloadCx[ticker] ?? 0) + (stop?.unloadChain.get(ticker)?.amount ?? 0);
      const load = stop?.load.get(ticker)?.amount ?? 0;
      const shortfall = cycleNetAmount(rate, days) + load - unload;
      if (shortfall > 1e-8) {
        reasons.push(
          `「${base.planetName || base.naturalId}」${ticker} 每轮缺 ${fixed02(shortfall)}。`,
        );
      }
      if ((unload > 0 || load > 0) && snapshot.materials[ticker] === undefined) {
        missingDimensions.add(ticker);
      }
    }
  }
  if (missingDimensions.size > 0) {
    reasons.push(`缺少物料重量或体积：${[...missingDimensions].join('、')}。`);
  }
  if (plan.hasUnmetChainDemand === true && reasons.length === 0) {
    reasons.push('必需的链上输送超过飞船剩余舱容。');
  }
  return reasons;
}

export async function computeLoopPlan(
  input: LoopPlanInput,
  estimate: (i: ChainFlightTimeInput) => Promise<ChainFlightEstimate> = estimateChainFlightTimes,
): Promise<LoopPlanResult> {
  const pre = loopEligibility({
    shipCount: 1,
    baseCount: input.bases.length,
    distinctDestinations: new Set([input.origin, ...input.bases.map(b => b.naturalId)]).size,
    estimateOk: true,
  });
  if (!pre.ok) {
    return { ok: false, reasons: pre.reasons, iterations: 0, converged: false };
  }
  const startAtMs = gameNow();
  const ship = { ...input.ship };
  const snapshot = collectChainPlanningSnapshot({
    originNaturalId: input.origin,
    capacity: input.capacity,
    bases: input.bases,
    loop: true,
    cycleDays: 1,
  });
  if (snapshot === undefined) {
    return {
      ok: false,
      reasons: ['缺少基地生产或消耗数据。'],
      iterations: 0,
      converged: false,
    };
  }
  const planForDays = (days: number) =>
    computeChainPlan(
      {
        ...snapshot,
        bases: snapshot.bases.map(base => ({ ...base, days, bill: loopBurnBill(base.burn, days) })),
      },
      fixed0,
    );
  let plan = planForDays(1);
  let iterations = 0;
  const tried = new Set<string>();
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!plan) {
      return { ok: false, reasons: ['无法生成环线计划。'], iterations, converged: false };
    }
    const signature = transferSignature(plan);
    if (tried.has(signature)) {
      break;
    }
    tried.add(signature);
    iterations++;
    const stops =
      plan.stops.length > 0
        ? plan.stops.map(s => ({ naturalId: s.naturalId, planetName: s.planetName }))
        : snapshot.bases
            .map(s => ({ naturalId: s.naturalId, planetName: s.planetName }))
            .filter(s => s.naturalId !== input.origin)
            .sort(
              (a, b) => snapshot.planetRanks[a.naturalId]! - snapshot.planetRanks[b.naturalId]!,
            );
    const candidate = plan;
    const legCount = stops.length + 1;
    const legPayloads = Array.from({ length: legCount }, (_, index) =>
      candidate.stops.length > 0 ? legLoadWeight(candidate, index + 1, legCount) : 0,
    );
    const est = await estimate({
      ship,
      origin: input.origin,
      stops,
      legPayloads,
      startAtMs,
      refuelAtOrigin: true,
      nativeRoute: true,
    });
    // 任一段判缺 ⇒ 得不到可靠周期，退回单趟（不进入循环模式）。
    if (!est.ok || !Number.isFinite(est.totalHours) || est.totalHours <= 0) {
      const failures = est.legs
        .filter(leg => !leg.ok)
        .map(leg => `${leg.from} → ${leg.to}：${leg.missingInputs?.join('；') ?? leg.error}`);
      return {
        ok: false,
        reasons: ['飞行估时不完整，无法确定循环周期。', ...failures],
        plan,
        estimate: est,
        iterations,
        converged: false,
      };
    }
    const cycleHours = est.totalHours;
    const days = cycleDaysFromHours(cycleHours);
    const next = planForDays(days);
    if (next !== undefined && transferSignature(next) === signature) {
      const reasons = validateLoopTransfers(next, snapshot, days);
      return {
        ok: reasons.length === 0,
        reasons,
        plan: next,
        cycleHours,
        estimate: est,
        iterations,
        converged: true,
      };
    }
    plan = next;
  }
  return {
    ok: false,
    reasons: ['循环周期和整数装卸量未收敛，请调整基地或更换飞船。'],
    iterations,
    converged: false,
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
  watch(
    [
      () => input.enabled(),
      () => input.ship()?.ship,
      () => input.ship()?.ship.condition,
      () => input.ship()?.cargoStore,
      () => input.ship()?.exchangeCode,
      () => input.bases(),
    ],
    () => void recompute(),
    { immediate: true },
  );
  onScopeDispose(() => {
    token++;
  });
  return { result, computing, error, recompute };
}
