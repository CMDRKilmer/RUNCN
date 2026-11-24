// 原生 RT 循环执行的纯计算（XIT FLEET）。不读 store、不发请求，输入全部由调用方传入。
// 稳态净额（cycleDays × (日耗 − 日产)）由这里的 cycleNetAmount/cycleDelivery 定义：
// 账单（chain-data）与 need/avail/提取（chain-plan-core）共用同一份口径；这里还负责
// 备货轮数、支撑轮数与资格校验。周期只是生成时快照：估时随出发时刻漂移，运行中不做后台重算。

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

export interface BurnRate {
  input: number;
  workforce: number;
  output: number;
}

// 单基地单 ticker 的周期净额：正 = 净缺口，负 = 净余量。用连续净额而不是逐项取整
// （ceil(日耗) − floor(日产)）——后者在「日产 ≥ 日耗」时也会虚报 1 单位缺口。
export function cycleNetAmount(rate: BurnRate, days: number): number {
  return days * (rate.input + rate.workforce - rate.output);
}

// 每轮送达量：净缺口向上取整，自给/净产不送。账单与链上 need 共用这一处，避免分叉。
export function cycleDelivery(rate: BurnRate, days: number): number {
  const net = cycleNetAmount(rate, days);
  return net > 0 ? Math.ceil(net) : 0;
}

// 基地净日耗 bundle：逐材料 max(0, 日耗 − 自产日产) × 单件重量/体积 求和。
// 自给材料（日产 ≥ 日耗）不消耗外部送达，不计入。任一净消耗材料缺重量/体积时返回
// undefined——宁可不出数，也不按偏小的需求报出偏大的可用天数。
export function netDailyBundle(
  burn: Readonly<Record<string, BurnRate>>,
  materialOf: (ticker: string) => { weight: number; volume: number } | undefined,
): { weight: number; volume: number } | undefined {
  let weight = 0;
  let volume = 0;
  for (const [ticker, mat] of Object.entries(burn)) {
    const net = cycleNetAmount(mat, 1);
    if (net <= 0) {
      continue;
    }
    const m = materialOf(ticker);
    if (m === undefined) {
      return undefined;
    }
    weight += net * m.weight;
    volume += net * m.volume;
  }
  return { weight, volume };
}

// 满载可用天数（按净日耗加权分摊）：各基地份额 ∝ 净日耗 bundle，等价于
// 总舱容 ÷ Σ净日耗 bundle（重量/体积取较小），各基地可用天数拉平。
// 仅「一次运输实际可用」展示口径——实际每轮送达按 周期 × 日耗 稳态，不装满。
// 自给基地净日耗为 0、不占分摊；无净消耗基地 → undefined。
export function fullLoadUsableDays(
  capacity: { weight: number; volume: number },
  bundles: readonly { weight: number; volume: number }[],
): number | undefined {
  let weight = 0;
  let volume = 0;
  for (const bundle of bundles) {
    weight += bundle.weight;
    volume += bundle.volume;
  }
  if (weight <= 0 && volume <= 0) {
    return undefined;
  }
  return Math.min(
    weight > 0 ? capacity.weight / weight : Infinity,
    volume > 0 ? capacity.volume / volume : Infinity,
  );
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
