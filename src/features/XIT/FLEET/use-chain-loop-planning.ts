// 原生 RT 循环执行的单船规划（XIT FLEET）。与多船时间均衡的 use-chain-planning 分离：
// 配货天数按整趟飞行时长向上取整。跨到另一档时用新货量重新估时。
import { ref, watch, onScopeDispose } from 'vue';
import { collectChainPlanningSnapshot, loopBurnBill } from './chain-data';
import { computeChainPlan, type ChainPlanningSnapshot } from './chain-plan-core';
import {
  estimateChainFlightTimes,
  type ChainFlightEstimate,
  type ChainFlightTimeInput,
} from './chain-flight-time';
import { legLoadWeight } from './native-route-plan';
import {
  cycleNetAmount,
  loopEligibility,
  loopSupplyDays,
  MIN_LOOP_SUPPLY_DAYS,
} from './native-route-loop';
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
  supplyDays?: number;
  cycleHours?: number;
  estimate?: ChainFlightEstimate;
}

const MAX_ESTIMATES = 8;

function validateLoopTransfers(plan: ChainPlan, snapshot: ChainPlanningSnapshot) {
  const reasons: string[] = [];
  if (plan.stops.length === 0) {
    reasons.push('本轮没有可执行的基地装卸。');
  }
  const stops = new Map(plan.stops.map(stop => [stop.naturalId, stop]));
  const missingDimensions = new Set<string>();
  for (const base of snapshot.bases) {
    const stop = stops.get(base.naturalId);
    for (const [ticker, rate] of Object.entries(base.burn)) {
      const unload = (stop?.unloadCx[ticker] ?? 0) + (stop?.unloadChain.get(ticker)?.amount ?? 0);
      const load = stop?.load.get(ticker)?.amount ?? 0;
      const shortfall = cycleNetAmount(rate, base.days) + load - unload;
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
    return { ok: false, reasons: pre.reasons };
  }
  const startAtMs = gameNow();
  const ship = { ...input.ship };
  const snapshot = collectChainPlanningSnapshot({
    originNaturalId: input.origin,
    capacity: input.capacity,
    bases: input.bases,
    loop: true,
  });
  if (snapshot === undefined) {
    return { ok: false, reasons: ['缺少基地生产或消耗数据。'] };
  }
  let days = MIN_LOOP_SUPPLY_DAYS;
  const triedDays = new Set<number>();
  while (triedDays.size < MAX_ESTIMATES && !triedDays.has(days)) {
    triedDays.add(days);
    const cargoSnapshot = {
      ...snapshot,
      bases: snapshot.bases.map(base => ({ ...base, days, bill: loopBurnBill(base.burn, days) })),
    };
    const plan = computeChainPlan(cargoSnapshot, fixed0);
    if (plan === undefined) {
      return { ok: false, reasons: ['无法生成环线计划。'] };
    }
    if (plan.overCapacity) {
      return {
        ok: false,
        reasons: [`按 ${days} 天配货的必需补给超过飞船剩余舱容。`],
        plan,
        supplyDays: days,
      };
    }
    // 试配货量取整为零时，先估算途经所选基地的空舱路线。
    const hasCargoStops = plan.stops.length > 0;
    const plannedStops = hasCargoStops
      ? plan.stops
      : snapshot.bases.filter(base => base.naturalId !== input.origin);
    const stops = plannedStops.map(({ naturalId, planetName }) => ({ naturalId, planetName }));
    if (!hasCargoStops) {
      stops.sort((a, b) => snapshot.planetRanks[a.naturalId]! - snapshot.planetRanks[b.naturalId]!);
    }
    const legCount = stops.length + 1;
    const est = await estimate({
      ship,
      origin: input.origin,
      stops,
      legPayloads: Array.from({ length: legCount }, (_, index) =>
        hasCargoStops ? legLoadWeight(plan, index + 1, legCount) : 0,
      ),
      startAtMs,
      refuelAtOrigin: true,
      nativeRoute: true,
    });
    if (!est.ok || !Number.isFinite(est.totalHours) || est.totalHours <= 0) {
      const failures = est.legs
        .filter(leg => !leg.ok)
        .map(leg => `${leg.from} → ${leg.to}：${leg.missingInputs?.join('；') ?? leg.error}`);
      return {
        ok: false,
        reasons: ['飞行估时不完整，无法确定配货天数。', ...failures],
        plan,
        estimate: est,
        supplyDays: days,
      };
    }
    const nextDays = loopSupplyDays(est.totalHours);
    if (nextDays === days) {
      const reasons = validateLoopTransfers(plan, cargoSnapshot);
      return {
        ok: reasons.length === 0,
        reasons,
        plan,
        supplyDays: days,
        cycleHours: est.totalHours,
        estimate: est,
      };
    }
    days = nextDays;
  }
  return { ok: false, reasons: ['配货天数与装载后的预计飞行时长未收敛。'] };
}

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
