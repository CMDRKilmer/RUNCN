// 原生 RT 循环执行的纯计算（XIT FLEET）。不读 store、不发请求，输入全部由调用方传入。
// 稳态 need（cycleDays×日耗、不减库存）在 computeChainPlan 的 loop 口径里算；这里只把
// 算好的 cxBill 加上每轮燃料，并做备货轮数、支撑轮数与资格校验。
// 周期只是生成时快照：估时随出发时刻漂移，运行中不做后台重算。

export interface LoopFuel {
  stl: number;
  ftl: number;
}

export interface LoopLegFuel {
  stlUsed?: number;
  ftlUsed?: number;
}

export function cycleDaysFromHours(cycleHours: number): number {
  return cycleHours / 24;
}

// 每轮燃料 = 逐段油耗之和（v1 只在出发地补满，整圈消耗即每轮补油量）。
// 某油罐任一段缺油耗时回退罐容量上限（偏保守），不伪造精确值。
export function fuelPerRound(
  legs: readonly LoopLegFuel[],
  tanks: { stlCap: number; ftlCap: number },
): LoopFuel {
  const sum = (pick: (leg: LoopLegFuel) => number | undefined, cap: number) => {
    if (legs.length === 0) {
      return cap;
    }
    let total = 0;
    for (const leg of legs) {
      const used = pick(leg);
      if (typeof used !== 'number' || !Number.isFinite(used)) {
        return cap;
      }
      total += used;
    }
    return total;
  };
  return {
    stl: sum(leg => leg.stlUsed, tanks.stlCap),
    ftl: sum(leg => leg.ftlUsed, tanks.ftlCap),
  };
}

// 每轮出发地账单 = cxBill + SF/FF（燃料 ticker 口径同 FTC/fuel-prices 的 FUEL_TICKERS）。
export function roundBill(
  cxBill: Readonly<Record<string, number>>,
  fuel: LoopFuel,
): Record<string, number> {
  const bill: Record<string, number> = { ...cxBill };
  if (fuel.stl > 0) {
    bill.SF = (bill.SF ?? 0) + fuel.stl;
  }
  if (fuel.ftl > 0) {
    bill.FF = (bill.FF ?? 0) + fuel.ftl;
  }
  return bill;
}

export function billWeightVolume(
  bill: Readonly<Record<string, number>>,
  materials: Readonly<Record<string, { weight: number; volume: number }>>,
): { weight: number; volume: number } {
  let weight = 0;
  let volume = 0;
  for (const [ticker, amount] of Object.entries(bill)) {
    weight += (materials[ticker]?.weight ?? 0) * amount;
    volume += (materials[ticker]?.volume ?? 0) * amount;
  }
  return { weight, volume };
}

// 备货轮数上限：N 轮账单总量不超过一船满载。
export function stockingRoundsMax(
  capacity: { weight: number; volume: number },
  cycle: { weight: number; volume: number },
): number {
  if (cycle.weight <= 0 && cycle.volume <= 0) {
    return 1;
  }
  const byWeight = cycle.weight > 0 ? capacity.weight / cycle.weight : Infinity;
  const byVolume = cycle.volume > 0 ? capacity.volume / cycle.volume : Infinity;
  return Math.max(1, Math.floor(Math.min(byWeight, byVolume)));
}

// 出发地库存可支撑轮数：按账单里最先耗尽的物料计算。空账单无消耗 → Infinity。
export function sustainRounds(
  bill: Readonly<Record<string, number>>,
  stock: Readonly<Record<string, number>>,
): number {
  let rounds = Infinity;
  for (const [ticker, amount] of Object.entries(bill)) {
    if (amount <= 0) {
      continue;
    }
    rounds = Math.min(rounds, Math.floor((stock[ticker] ?? 0) / amount));
  }
  return rounds;
}

// 每轮出发地账单 + 可支撑轮数。燃料只认生成时的每轮快照：游戏里手建的循环航线没有快照，
// 按罐容量估会把整圈当成耗满一罐（支撑轮数偏少、误报「不足 1 轮」），故不猜——账单只含物料，
// 支撑轮数返回 undefined（未知，卡片显示「—」）。
export function loopSustain(
  cxBill: Readonly<Record<string, number>>,
  fuel: LoopFuel | undefined,
  stock: Readonly<Record<string, number>>,
): { bill: Record<string, number>; sustain: number | undefined } {
  if (fuel === undefined) {
    return { bill: { ...cxBill }, sustain: undefined };
  }
  const bill = roundBill(cxBill, fuel);
  return { bill, sustain: sustainRounds(bill, stock) };
}

export interface LoopEligibility {
  shipCount: number;
  baseCount: number;
  distinctDestinations: number;
  estimateOk: boolean;
}

export function loopEligibility(input: LoopEligibility): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.shipCount !== 1) {
    reasons.push('循环模式只支持恰好 1 艘船。');
  }
  if (input.baseCount < 1) {
    reasons.push('至少需要 1 个基地。');
  }
  if (input.distinctDestinations < 2) {
    reasons.push('至少需要 2 个不同目的地。');
  }
  if (!input.estimateOk) {
    reasons.push('飞行估时不完整，无法确定循环周期。');
  }
  return { ok: reasons.length === 0, reasons };
}

// 循环模式与 ACT 执行面的边界：循环下规划表展示的是闭环稳态，而 ACT 执行面（shipPlans →
// executeChainPlans）仍是单趟口径，放行会把每轮运量少写一个数量级。按钮 tooltip 与 execute()
// 拦截共用这一处文案，避免两处口径漂移；唯一出口是「生成原生 RT」。
export const LOOP_ACT_BLOCKED =
  '循环模式不生成 ACT 包/触发器：请用「生成原生 RT」把闭环写入游戏航线。';

export function actBlockedReason(loopActive: boolean): string | undefined {
  return loopActive ? LOOP_ACT_BLOCKED : undefined;
}
