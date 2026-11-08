import type { DispatchShip } from './utils';
import type { ChainCapacity, ChainPlan, ChainStopPlan, ChainPlannerBase } from './chain-types';
import { planChainRoute } from './chain-planner';
import { effectiveBurn, matWeightVolume } from './chain-data';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { getBaseProducts } from '@src/core/base-products';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';

// ── 多船分配 ─────────────────────────────────────────────────
// 环线支持多船（不限数量）：合并多船舱容后，把货物按方案分配到各船，
// 每船生成独立的一套操作包 + 触发器。
// 分段策略：
// - 默认（无飞行预估）：按舱容贪心切连续段——只在「装不下」时换下一艘；
//   结果以容量为准，不保证时间均衡，且单船装得下时其余船会闲置。
// - 时间均衡（推荐，多船并行出动）：先给每艘船预估整条合并环线的飞行时长，
//   再用 planTimeBalancedSegments 求 makespan 最小的连续分段（总耗时 =
//   最慢那艘船的闭环时长），让多船真正并行提速，快船可多跑、慢船少跑。

/** 单船舱容（含总量与剩余）。 */
export function shipChainCapacity(ship: DispatchShip): ChainCapacity | undefined {
  const c = ship.cargoStore;
  if (!c) {
    return undefined;
  }
  return {
    weight: c.weightCapacity,
    volume: c.volumeCapacity,
    freeWeight: c.weightCapacity - c.weightLoad,
    freeVolume: c.volumeCapacity - c.volumeLoad,
  };
}

/** 船只出发地 naturalId（优先当前位置，退化到所在 CX 代码）。 */
export function shipOriginNaturalId(ship: DispatchShip): string {
  return getEntityNaturalIdFromAddress(ship.ship.address ?? undefined) ?? ship.exchangeCode;
}

/** 船只所在空间站仓库库存（ticker → 数量），用于出发地「取货」补足组内产出缺口。 */
export function shipWarehouseStock(ship: DispatchShip): Record<string, number> | undefined {
  const store = ship.warehouseStore;
  if (!store) {
    return undefined;
  }
  const stock: Record<string, number> = {};
  for (const item of store.items) {
    if (item.quantity) {
      const ticker = item.quantity.material.ticker;
      stock[ticker] = (stock[ticker] ?? 0) + item.quantity.amount;
    }
  }
  return stock;
}

/** 合并多船舱容。全部无货舱时返回 undefined。 */
export function buildCombinedCapacity(ships: DispatchShip[]): ChainCapacity | undefined {
  let weight = 0;
  let volume = 0;
  let freeWeight = 0;
  let freeVolume = 0;
  let any = false;
  for (const ship of ships) {
    const c = shipChainCapacity(ship);
    if (!c) {
      continue;
    }
    any = true;
    weight += c.weight;
    volume += c.volume;
    freeWeight += c.freeWeight;
    freeVolume += c.freeVolume;
  }
  return any ? { weight, volume, freeWeight, freeVolume } : undefined;
}

export interface ShipChainPlan {
  ship: DispatchShip;
  plan: ChainPlan;
}

// 站点货物总重量/体积（卸货 + 提取）——用于按容量分配站点。
function stopShipmentSize(stop: ChainStopPlan) {
  let weight = 0;
  let volume = 0;
  const add = (ticker: string, amount: number) => {
    if (amount <= 0) {
      return;
    }
    const wv = matWeightVolume(ticker, amount);
    weight += wv.weight;
    volume += wv.volume;
  };
  for (const [ticker, amount] of Object.entries(stop.unloadCx)) {
    add(ticker, amount);
  }
  for (const [ticker, entry] of stop.unloadChain) {
    add(ticker, entry.amount);
  }
  for (const [ticker, entry] of stop.load) {
    add(ticker, entry.amount);
  }
  return { weight, volume };
}

/** 每站货物总重量/体积（卸货 + 提取）——供时间均衡分段做容量约束。 */
export function chainStopShipmentSizes(plan: ChainPlan): { weight: number; volume: number }[] {
  return plan.stops.map(stop => stopShipmentSize(stop));
}

/**
 * 时间均衡分段（makespan 最小化）：
 * 多船并行出动时，整条环线完成一轮补给的总耗时 = 最慢那艘船的闭环时长
 * （瓶颈船）。本函数把一条合并环线的有序站点切成连续段（每船负责一段、
 * 同时出动），使「各船闭环时长最大值」最小，即让多船真正并行提速。
 *
 * 段代价模型（每船给「沿整条合并环线完整闭环」的逐段实测小时 legs[0..n]，
 * legs[0]=出发地→站0、legs[k]=站_{k-1}→站_k、legs[n]=站_{n-1}→出发地）：
 * 段 [a,b)（服务站点 a..b-1）闭环 = 出发地→段首站 + 段内相邻站（实测 legs 前缀和）
 * + 段尾站→出发地。出发地↔内层端点的直飞腿不在整环 legs 里（整环里该位置是
 * 「段尾站→下一站」），用该船两个实测端点腿的平均值作代理（不偏不倚的近似，
 * 只影响切点选取，不影响最终展示——展示用分配后各段的精确实测）。
 * 船速差异自然体现：快船可承担更长的段。允许空段（该船不参与）——段切得越碎，
 * 每段越要额外飞「出发地↔段端点」长途往返，不一定更快，DP 自动在「并行提速」
 * 与「端点 overhead」间取最优，不盲目用尽全部船。
 *
 * 容量为硬约束（段内货物 ≤ 该船剩余舱容），保证子规划不会因超载而裁剪货物；
 * 若全部船严格限容无解（如某站货物超所有船），回退到最后那艘船兜底
 * （不做容量约束，与舱容贪心一致，宁可超载也必须有船接）。
 *
 * @returns { ranges: 与 loopLegHours 对齐的每艘船段区间 [start,end)（可为空段）,
 *            hours: 对齐的每船段预计闭环小时（与 DP 同口径）}；输入非法返回 undefined。
 */
export function planTimeBalancedSegments(input: {
  // 每艘船沿合并环线完整闭环的逐段飞行小时，长度 = stopSizes.length + 1。
  loopLegHours: number[][];
  // 每艘船剩余舱容（与 loopLegHours 对齐）。
  capacities: { freeWeight: number; freeVolume: number }[];
  // 每站货物尺寸（重量/体积，与站点顺序对齐）。
  stopSizes: { weight: number; volume: number }[];
}): { ranges: { start: number; end: number }[]; hours: number[] } | undefined {
  const n = input.stopSizes.length;
  const m = input.loopLegHours.length;
  if (m === 0 || n === 0) {
    return { ranges: [], hours: [] };
  }
  if (input.capacities.length !== m) {
    return undefined;
  }
  // 段内相邻站前缀和：p[k] = Σ_{t=1..k} legs[t]（不含首尾两段）。
  const interiorPrefix = input.loopLegHours.map(legs => {
    const p: number[] = [0];
    for (let k = 1; k < legs.length; k++) {
      p.push(p[p.length - 1]! + legs[k]!);
    }
    return p;
  });
  // 货物累计 W/V[i] = Σ_{t<i} 重量/体积。
  const W: number[] = [0];
  const V: number[] = [0];
  for (const s of input.stopSizes) {
    W.push(W[W.length - 1]! + s.weight);
    V.push(V[V.length - 1]! + s.volume);
  }
  // 段 [a,b) 闭环小时：首尾直飞腿（端点代理）+ 段内相邻站实测。
  const segCost = (j: number, a: number, b: number) => {
    if (a >= b) {
      return 0;
    }
    const legs = input.loopLegHours[j]!;
    const avgEndpoint = (legs[0]! + legs[n]!) / 2;
    const out = a === 0 ? legs[0]! : avgEndpoint;
    const ret = b === n ? legs[n]! : avgEndpoint;
    const interior = interiorPrefix[j]![b - 1]! - interiorPrefix[j]![a]!;
    return out + interior + ret;
  };
  // dp[j][i]：前 j 艘船覆盖前 i 站的最小 makespan；choice[j][i] = 第 j 艘船段起点。
  const solve = (relaxLast: boolean): { start: number; end: number }[] | undefined => {
    const fits = (j: number, a: number, b: number) => {
      if (a >= b) {
        return true;
      }
      // 兜底模式：最后一艘船不做容量约束。
      if (relaxLast && j === m - 1) {
        return true;
      }
      const cap = input.capacities[j]!;
      return W[b]! - W[a]! <= cap.freeWeight && V[b]! - V[a]! <= cap.freeVolume;
    };
    const INF = Number.POSITIVE_INFINITY;
    const dp: number[][] = [];
    const choice: number[][] = [];
    for (let j = 0; j <= m; j++) {
      dp.push(new Array<number>(n + 1).fill(INF));
      choice.push(new Array<number>(n + 1).fill(-1));
    }
    dp[0]![0] = 0;
    for (let j = 1; j <= m; j++) {
      for (let i = 0; i <= n; i++) {
        let best = INF;
        let bestA = -1;
        for (let a = 0; a <= i; a++) {
          if (dp[j - 1]![a]! >= INF || !fits(j - 1, a, i)) {
            continue;
          }
          const val = Math.max(dp[j - 1]![a]!, segCost(j - 1, a, i));
          // 相同 makespan 时优先把站段留给更靠前的船（当前船段起点 a 尽量大），
          // 避免「整环单船最优」这类场景把整条环线落到最后一艘、前面船闲置。
          if (val < best || (val === best && a > bestA)) {
            best = val;
            bestA = a;
          }
        }
        if (bestA >= 0) {
          dp[j]![i] = best;
          choice[j]![i] = bestA;
        }
      }
    }
    if (dp[m]![n]! >= INF) {
      return undefined;
    }
    const ranges: { start: number; end: number }[] = [];
    let i = n;
    for (let j = m; j >= 1; j--) {
      const a = choice[j]![i]!;
      ranges.push({ start: a, end: i });
      i = a;
    }
    return ranges.reverse();
  };
  // 优先严格限容（不超载任何船）；无解时回退到「最后一艘兜底」。
  const ranges = solve(false) ?? solve(true);
  if (!ranges) {
    return undefined;
  }
  return {
    ranges,
    hours: ranges.map((r, j) => segCost(j, r.start, r.end)),
  };
}

// 按飞船剩余舱容把有序站点切成连续段：逐站装箱，当前船装不下
// （重量或体积任一超出该船剩余容量）才换下一艘，最后一艘兜底。
// 产物密度（大重量小体积 / 大体积小重量）自然决定段边界：
// 大重量货物集中的段会落到 weight 容量充裕的船，低密度货物则看 volume。
function chunkBasesByCapacity(
  ordered: ChainPlannerBase[],
  plan: ChainPlan,
  usable: DispatchShip[],
): ChainPlannerBase[][] {
  const byId = new Map(ordered.map(b => [b.naturalId, b] as const));
  const caps = usable.map(s => shipChainCapacity(s)!);
  const sizes = plan.stops.map(stop => {
    const base = byId.get(stop.naturalId);
    if (!base) {
      return { weight: 0, volume: 0 };
    }
    return stopShipmentSize(stop);
  });

  const chunks: ChainPlannerBase[][] = [];
  let current: ChainPlannerBase[] = [];
  let accW = 0;
  let accV = 0;
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      accW = 0;
      accV = 0;
    }
  };
  for (let i = 0; i < plan.stops.length; i++) {
    const stop = plan.stops[i]!;
    const base = byId.get(stop.naturalId);
    if (!base) {
      continue;
    }
    const size = sizes[i]!;
    const j = chunks.length;
    const cap = caps[j]!;
    const hasNext = j + 1 < usable.length;
    if (
      hasNext &&
      current.length > 0 &&
      (accW + size.weight > cap.freeWeight || accV + size.volume > cap.freeVolume)
    ) {
      flush();
    }
    current.push(base);
    accW += size.weight;
    accV += size.volume;
  }
  flush();
  return chunks;
}

/**
 * 并行分段：把合并容量的单一环线计划切成连续段（按飞船容量贪心，
 * 或调用方给的时间均衡分段），每艘船独立规划其段的子环线并同时出动。
 * 跨段产物经出发地仓库（取货）接力。
 * 无货舱（或剩余舱容为 0）的船不参与分段。
 */
export function splitChainPlanAcrossShips(
  plan: ChainPlan,
  ships: DispatchShip[],
  bases: ChainPlannerBase[],
  // 各站预计到达小时数：传给分段子规划，取货量按到港时预计库存计算
  //（基础规划不传，仅主规划传，避免影响飞行预估用的站点顺序）。
  arrivalHoursByNaturalId?: Map<string, number>,
  // 时间均衡分段结果（可选，与 usable 对齐：每艘船分配的连续站点 naturalId），
  // 由 planTimeBalancedSegments 求解，使各船闭环时长均衡（更快完成补给）。
  // 未提供 / 长度与 usable 不匹配时退回按舱容贪心切段（旧行为）。
  allocByNaturalId?: string[][],
): ShipChainPlan[] {
  const byId = new Map(bases.map(b => [b.naturalId, b] as const));
  const ordered = plan.stops
    .map(s => byId.get(s.naturalId))
    .filter((b): b is ChainPlannerBase => b !== undefined);
  // 参与船：有货舱且剩余舱容 > 0。
  const usable = ships.filter(s => {
    const c = shipChainCapacity(s);
    return c !== undefined && (c.freeWeight > 0 || c.freeVolume > 0);
  });
  if (usable.length === 0 || ordered.length === 0) {
    return [];
  }
  // 分段：优先用时间均衡分配（与 usable 一一对齐，空段 = 该船不参与）；
  // 否则按飞船剩余舱容贪心切连续段（大船多装、小船少装）。
  let chunks: ChainPlannerBase[][];
  if (allocByNaturalId !== undefined && allocByNaturalId.length === usable.length) {
    chunks = allocByNaturalId.map(ids =>
      ids.map(id => byId.get(id)).filter((b): b is ChainPlannerBase => b !== undefined),
    );
  } else {
    chunks = chunkBasesByCapacity(ordered, plan, usable);
  }

  // 全局组内产出集合（BSN 白名单 + output>0）：跨段产物在任何段都不纳入采购，
  // 保证封闭环内自产自销不因分段边界而被误采。
  const groupProducedTickers = new Set<string>();
  for (const base of bases) {
    const configured = getBaseProducts(base.siteId);
    if (configured === undefined) {
      continue;
    }
    const burn = effectiveBurn(base.siteId);
    if (!burn) {
      continue;
    }
    for (const ticker of configured) {
      const mat = burn[ticker];
      if (mat !== undefined && mat.output > 0) {
        groupProducedTickers.add(ticker);
      }
    }
  }

  const warehouses = new Map<string, Record<string, number>>();
  const markets = new Map<string, Record<string, number>>();
  const result: ShipChainPlan[] = [];
  for (let i = 0; i < chunks.length && i < usable.length; i++) {
    const ship = usable[i]!;
    const chunk = chunks[i]!;
    if (chunk.length === 0) {
      continue;
    }
    const cap = shipChainCapacity(ship);
    if (!cap) {
      continue;
    }
    const warehouseKey = ship.warehouseStore?.id ?? ship.ship.id;
    let stock = warehouses.get(warehouseKey);
    if (stock === undefined) {
      stock = shipWarehouseStock(ship) ?? {};
      warehouses.set(warehouseKey, stock);
    }
    let supply = markets.get(ship.exchangeCode);
    if (supply === undefined) {
      supply = {};
      markets.set(ship.exchangeCode, supply);
      for (const ticker of Object.keys(plan.purchaseBill)) {
        const broker = cxobStore.getByTicker(`${ticker}.${ship.exchangeCode}`);
        if (broker !== undefined) {
          supply[ticker] = Math.max(0, Math.floor(broker.supply));
        }
      }
    }
    const sub = planChainRoute({
      originNaturalId: shipOriginNaturalId(ship),
      capacity: cap,
      bases: chunk,
      originStock: stock,
      purchaseStock: supply,
      groupProducedTickers,
      exchangeCode: ship.exchangeCode,
      ...(arrivalHoursByNaturalId !== undefined ? { arrivalHoursByNaturalId } : {}),
    });
    if (sub) {
      for (const [ticker, amount] of Object.entries(sub.originPickup)) {
        stock[ticker] = Math.max(0, (stock[ticker] ?? 0) - amount);
      }
      for (const [ticker, amount] of Object.entries(sub.purchaseBill)) {
        const available =
          supply[ticker] ?? cxobStore.getByTicker(`${ticker}.${ship.exchangeCode}`)?.supply;
        if (available !== undefined) {
          supply[ticker] = Math.max(0, Math.floor(available) - amount);
        }
      }
      result.push({ ship, plan: sub });
    }
  }

  return result;
}
