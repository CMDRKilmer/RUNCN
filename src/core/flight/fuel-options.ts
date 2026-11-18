export interface FuelTradeoff {
  fuel: number;
  reactor: number;
  stlFuel: number;
  ftlFuel: number;
  totalHours: number;
}

// Pareto knee, with minimum fuel as the tie-breaker for a degenerate frontier.
export function totalFuelOf(o: FuelTradeoff): number {
  return o.stlFuel + o.ftlFuel;
}

export function paretoFrontier<T extends FuelTradeoff>(options: T[]): T[] {
  return options
    .filter(
      o =>
        !options.some(
          p =>
            p !== o &&
            p.totalHours <= o.totalHours &&
            totalFuelOf(p) <= totalFuelOf(o) &&
            (p.totalHours < o.totalHours || totalFuelOf(p) < totalFuelOf(o)),
        ),
    )
    .sort((a, b) => a.totalHours - b.totalHours);
}

const BALANCE_TIE_EPS = 1e-9;

function cheapestFuelOption<T extends FuelTradeoff>(options: T[]): T | undefined {
  let best: T | undefined;
  for (const o of options) {
    if (best === undefined) {
      best = o;
      continue;
    }
    const fuelDelta = totalFuelOf(o) - totalFuelOf(best);
    if (fuelDelta < -BALANCE_TIE_EPS) {
      best = o;
      continue;
    }
    if (fuelDelta > BALANCE_TIE_EPS) {
      continue;
    }
    const reactorDelta = o.reactor - best.reactor;
    if (reactorDelta < -BALANCE_TIE_EPS) {
      best = o;
      continue;
    }
    if (reactorDelta > BALANCE_TIE_EPS) {
      continue;
    }
    if (o.fuel < best.fuel) {
      best = o;
    }
  }
  return best;
}

export function findBalanceOption<T extends FuelTradeoff>(options: T[]): T | undefined {
  const pareto = paretoFrontier(options);
  if (pareto.length === 0) {
    return undefined;
  }
  const cheapest = cheapestFuelOption(options);
  const allFuels = options.map(totalFuelOf);
  const fuelSpan = Math.max(...allFuels) - Math.min(...allFuels);
  const allHours = options.map(o => o.totalHours);
  const timeSpan = Math.max(...allHours) - Math.min(...allHours);
  if (!(fuelSpan > BALANCE_TIE_EPS)) {
    return cheapest ?? pareto[0];
  }
  if (!(timeSpan > BALANCE_TIE_EPS)) {
    return cheapest ?? pareto[0];
  }
  if (pareto.length === 1) {
    return pareto[0];
  }
  const fastest = pareto[0];
  const slowest = pareto[pareto.length - 1];
  const tSpan = slowest.totalHours - fastest.totalHours;
  const paretoFuels = pareto.map(totalFuelOf);
  const fMin = Math.min(...paretoFuels);
  const fSpan = Math.max(...paretoFuels) - fMin;
  let best = fastest;
  let bestDist = -1;
  for (const o of pareto) {
    const x = (o.totalHours - fastest.totalHours) / tSpan;
    const y = (totalFuelOf(o) - fMin) / fSpan;
    const dist = Math.abs(x + y - 1);
    if (dist > bestDist) {
      bestDist = dist;
      best = o;
    }
  }
  return best;
}

// 最优性价比：沿着燃料档往上走，每 +1 个百分点燃料换回的时间（小时/百分点）跌破
// 首档的一半就停——临近饱和段速度提升很小、燃料却继续涨，正是该停的位置。
export const MARGINAL_RETENTION = 0.5;

export function pickBestValueOption<T extends FuelTradeoff>(
  options: T[],
  maxFuel?: number,
): T | undefined {
  const candidates = options.filter(o => maxFuel === undefined || o.fuel <= maxFuel);
  if (candidates.length === 0) {
    return undefined;
  }
  // 反应堆使用量与燃料档位正交（只影响 FTL 速度/充能），必须按反应堆分组后
  // 在**同一序列内**比较「多烧 1% 燃料换回多少时间」；跨反应堆混排会把反应堆
  // 带来的时间差算进燃料边际收益，结果随输入顺序变化（同一航线可算出 10%/30%
  // 或 20%/100% 两种结论）。
  const series = new Map<number, T[]>();
  for (const option of candidates) {
    const key = Math.round(option.reactor * 1000);
    const list = series.get(key);
    if (list === undefined) {
      series.set(key, [option]);
    } else {
      list.push(option);
    }
  }
  const picks: T[] = [];
  for (const list of series.values()) {
    const pick = pickSeriesValue(list);
    if (pick !== undefined) {
      picks.push(pick);
    }
  }
  if (picks.length === 0) {
    return undefined;
  }
  // 单一反应堆（BTF 实测样本、纯网关/系内航线）：序列内结果就是最终结果。
  if (picks.length === 1) {
    return picks[0];
  }
  // 跨反应堆必须按**实际时间与消耗**比较：自然跃迁航线上，每个反应堆序列给 STL 曲线
  // 加的是同一个常数时间，序列内「时间/燃料」比值会把反应堆的时间优势抵消掉，于是选出
  // 的可能是「更慢又更费油」的劣解。先剔除被严格支配的候选，再按同一套折衷口径选点
  // （无差异 → 最省油）。
  const frontier = paretoFrontier(picks);
  if (frontier.length === 1) {
    return frontier[0];
  }
  return findBalanceOption(frontier) ?? frontier[0];
}

// 固定反应堆序列内的性价比拐点。
function pickSeriesValue<T extends FuelTradeoff>(options: T[]): T | undefined {
  const sorted = options.slice().sort((a, b) => a.fuel - b.fuel);
  const first = sorted[0]!;
  const fuels = sorted.map(totalFuelOf);
  // 燃料完全无差别（短途、由固定起降段主导）：时间更短的方案严格占优。
  if (!(Math.max(...fuels) - Math.min(...fuels) > 1e-9)) {
    return sorted.reduce((a, b) => (b.totalHours < a.totalHours ? b : a));
  }
  let best = first;
  let firstRate: number | undefined;
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    const deltaFuel = current.fuel - previous.fuel;
    const deltaHours = previous.totalHours - current.totalHours;
    if (!(deltaFuel > 0)) {
      continue;
    }
    const rate = deltaHours / deltaFuel;
    if (firstRate === undefined) {
      if (!(rate > 0)) {
        return findBalanceOption(sorted) ?? best;
      }
      firstRate = rate;
      best = current;
      continue;
    }
    if (!(rate > 0) || rate < firstRate * MARGINAL_RETENTION) {
      break;
    }
    best = current;
  }
  return best;
}
