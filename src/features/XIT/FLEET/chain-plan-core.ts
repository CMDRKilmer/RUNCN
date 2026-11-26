import type { BurnValues, MaterialBurn } from '@src/core/burn';
import {
  cycleDelivery,
  cycleNetAmount,
  fullLoadUsableDays,
  netDailyBundle,
} from './native-route-loop';
import {
  pushItemsPrioritised as pushItemsPrioritisedPure,
  pushItemsProportional as pushItemsProportionalPure,
  type CargoItem as CargoItemFit,
  type CargoState,
} from './chain-fit';
import type {
  ChainCapacity,
  ChainPlan,
  ChainStopPlan,
  CargoItem,
  ChainFlow,
  ChainFilteredStop,
} from './chain-types';

export interface ChainPlanningBase {
  naturalId: string;
  planetName: string;
  days: number;
  cxBuy: boolean;
  burn: BurnValues;
  bill: Record<string, number>;
  products: string[];
  projectedStock: Record<string, number>;
  daysUntilFull: number;
}
export interface ChainPlanningSnapshot {
  originNaturalId: string;
  capacity: ChainCapacity;
  bases: ChainPlanningBase[];
  consumers: Map<string, string[]>;
  materials: Record<string, { weight: number; volume: number }>;
  planetRanks: Record<string, number>;
  originStock: Record<string, number>;
  purchaseStock: Record<string, number>;
  groupProducedTickers?: Set<string>;
  // 循环模式：need/账单按周期净缺口（天数 × (日耗 − 日产)，不减库存），
  // 自产材料基地自留一轮生产所需；avail/提取按周期净余量补偿回本轮送达，
  // 不用到港预计库存。固定步骤每轮重复执行，减库存或装尽库存都会让基地逐轮饿死/库存漂移。
  loop?: boolean;
}

export function computeChainPlan(
  input: ChainPlanningSnapshot,
  formatAmount: (amount: number) => string,
): ChainPlan | undefined {
  const { originNaturalId, capacity, bases } = input;
  if (capacity.weight <= 0 && capacity.volume <= 0) {
    return undefined;
  }

  const warnings: string[] = [];

  const burns = new Map(bases.map(x => [x.naturalId, x.burn]));
  const comparePlanets = (a: string, b: string) => input.planetRanks[a] - input.planetRanks[b];
  const matWeightVolume = (ticker: string, amount: number) => ({
    weight: (input.materials[ticker]?.weight ?? 0) * amount,
    volume: (input.materials[ticker]?.volume ?? 0) * amount,
  });
  // 循环满载可用天数（总舱容 ÷ Σ净日耗 bundle，加权分摊）：仅「满载可用」
  // 展示口径；每轮按装卸计划配货。任一净消耗材料缺重量/体积时
  // 不出数（显示 —），不按偏小的需求报大天数。
  let fullLoadDays: number | undefined;
  if (input.loop) {
    const bundles: { weight: number; volume: number }[] = [];
    let complete = true;
    for (const base of bases) {
      const bundle = netDailyBundle(base.burn, t =>
        input.materials[t] === undefined ? undefined : matWeightVolume(t, 1),
      );
      if (bundle === undefined) {
        complete = false;
        break;
      }
      bundles.push(bundle);
    }
    if (complete) {
      fullLoadDays = fullLoadUsableDays(
        { weight: capacity.weight, volume: capacity.volume },
        bundles,
      );
    }
  }
  // 预读白名单：BSN 中配置的 ticker 是「可提取产物白名单」，
  // 只有白名单上的 ticker 才能被提取（送下游或运回出发地）。
  // producer 推断仅考虑白名单 ticker（不白名单 = 中间产物，不参与搬运）。
  const allowlistedProducers = new Map<string, Set<string>>(); // ticker → bases with it in BSN
  for (const base of bases) {
    const configured = base.products;
    if (configured === undefined || configured.length === 0) {
      continue;
    }
    const burn = burns.get(base.naturalId)!;
    let i = 0;
    while (i < configured.length) {
      const ticker = configured[i]!;
      const mat = burn[ticker];
      if (mat === undefined || mat.output <= 0) {
        i++;
        continue;
      }
      let set: Set<string> | undefined = allowlistedProducers.get(ticker);
      if (set === undefined) {
        set = new Set<string>();
        allowlistedProducers.set(ticker, set);
      }
      set.add(base.naturalId);
      i++;
    }
  }

  // 推断产业链边：A 产出 T 且 B 消耗 T（原料或劳动力消耗品）→ A→B。
  // consumer 来源扩展到所有玩家基地（不仅是 selectedBases）——
  // 避免选中基地的 ticker 被误判为最终产物（实际它是其他玩家基地的下游消耗）。
  // burn 数据未就绪的基地会被天然忽略。
  // producer 集合仅包含白名单 ticker（中间产物不进入链上输送）。
  const producers = new Map<string, string[]>();
  const consumers = input.consumers;
  for (const base of bases) {
    const burn = burns.get(base.naturalId)!;
    for (const [ticker, mat] of Object.entries(burn)) {
      if (mat.output > 0 && allowlistedProducers.has(ticker)) {
        const list = producers.get(ticker) ?? [];
        list.push(base.naturalId);
        producers.set(ticker, list);
      }
    }
  }
  const rawEdges: ChainFlow[] = [];
  for (const [ticker, producerIds] of producers) {
    const consumerIds = consumers.get(ticker) ?? [];
    // 进一步限制 producer 为白名单集合（仅白名单 base能产该 ticker）
    const allowedSet = allowlistedProducers.get(ticker)!;
    for (const from of producerIds) {
      if (!allowedSet.has(from)) {
        continue;
      }
      for (const to of consumerIds) {
        if (from === to) {
          continue;
        }
        rawEdges.push({ ticker, from, to, amount: 0 });
      }
    }
  }

  const plan: ChainPlan = {
    originNaturalId,
    stops: [],
    finalUnload: {},
    cxBill: {},
    purchaseBill: {},
    originPickup: {},
    warnings,
    peakLoad: { weight: 0, volume: 0 },
    freeCapacity: {
      weight: capacity.freeWeight,
      volume: capacity.freeVolume,
    },
    capacity: {
      weight: capacity.weight,
      volume: capacity.volume,
    },
    loadOnDeparture: { weight: 0, volume: 0 },
    loadOnReturn: { weight: 0, volume: 0 },
    overCapacity: false,
  };

  if (rawEdges.length === 0) {
    warnings.push('未检测到基地间的产业链关系，将执行纯补给环线（采购 → 卸货 → 提取 → 归航）。');
  }

  // Kahn 拓扑排序（同层按星球名稳定排序）；所有选中基地入序，
  // 无链关系的基地为孤立节点，按字母序混入航线。
  const allIds = bases.map(x => x.naturalId);
  const adjacency = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const id of allIds) {
    adjacency.set(id, new Set());
    inDegree.set(id, 0);
  }
  for (const edge of rawEdges) {
    adjacency.get(edge.from)!.add(edge.to);
  }
  for (const tos of adjacency.values()) {
    for (const to of tos) {
      inDegree.set(to, inDegree.get(to)! + 1);
    }
  }
  const frontier = allIds.filter(x => inDegree.get(x) === 0).sort(comparePlanets);
  const order: string[] = [];
  while (frontier.length > 0) {
    const next = frontier.shift()!;
    order.push(next);
    for (const to of adjacency.get(next)!) {
      const degree = inDegree.get(to)! - 1;
      inDegree.set(to, degree);
      if (degree === 0) {
        frontier.push(to);
      }
    }
    frontier.sort(comparePlanets);
  }
  if (order.length < allIds.length) {
    warnings.push('产业链存在循环依赖，循环部分的输送顺序可能不满足上下游先后。');
    const ordered = new Set(order);
    for (const id of [...allIds].sort(comparePlanets)) {
      if (!ordered.has(id)) {
        order.push(id);
      }
    }
  }

  // 循环断链：只保留「上游在下游之前到访」的边。
  const position = new Map(order.map((id, i) => [id, i] as const));
  const edges = rawEdges.filter(x => position.get(x.from)! < position.get(x.to)!);
  const dropped = rawEdges.length - edges.length;
  if (dropped > 0) {
    warnings.push(`已忽略 ${dropped} 条循环输送（上游在下游之后到访，无法顺路输送）。`);
  }

  const byNaturalId = new Map(bases.map(x => [x.naturalId, x] as const));

  // 到达时刻预计库存：飞行期间基地继续生产，到港时可提取量高于当前库存。
  // 产出和消耗已由输入快照按到港时刻折算。
  // 未提供到达时刻（无飞行预估）时退化为当前库存，保持旧行为。
  const projectedInventory = (mat: MaterialBurn | undefined, ticker: string, id: string) =>
    mat === undefined ? 0 : (byNaturalId.get(id)!.projectedStock[ticker] ?? mat.inventory);

  // 目标天数（所有选中基地，含无链关系基地的采购补给）。
  const targetDays = new Map<string, number>();
  for (const base of bases) {
    targetDays.set(base.naturalId, base.days);
  }
  // need: 下游 ticker 需求 = 目标天数 × 日耗（原料+消耗品）− 库存。
  // 循环模式按稳态净缺口（不减库存、自产抵扣）：固定步骤每轮重复，减库存会逐轮少送、基地饿死。
  const need = (id: string, ticker: string) => {
    const mat = burns.get(id)![ticker];
    // ticker 不在该基地 burn 中（极少见，例如生产订单刚启动 burn 尚未刷新）→ 按 0 计。
    if (mat === undefined) {
      return 0;
    }
    if (input.loop) {
      // 自产材料只补净缺口（日耗 − 日产），自给/净产不送。
      return cycleDelivery(mat, targetDays.get(id)!);
    }
    const gross = targetDays.get(id)! * (mat.input + mat.workforce);
    return Math.max(0, Math.ceil(gross - mat.inventory));
  };
  // avail: 上游可提取 = 到达时预计库存 − 自用预留（目标天数 × 自身日耗）。
  // 循环模式 = 周期净余量（日产 − 日耗）：流量分配阶段 incoming 未知，先按全额自用
  // 保守扣减；实际提取（余量运回/最终产物）在 incoming 确定后只扣未被送达覆盖的部分
  // （loopExtractable）。
  const avail = (id: string, ticker: string) => {
    const mat = burns.get(id)![ticker];
    if (mat === undefined) {
      return 0;
    }
    if (input.loop) {
      return Math.max(0, Math.floor(-cycleNetAmount(mat, targetDays.get(id)!)));
    }
    return Math.max(
      0,
      Math.floor(
        projectedInventory(mat, ticker, id) - targetDays.get(id)! * (mat.input + mat.workforce),
      ),
    );
  };

  // 按 ticker 平衡：多下游共享多上游时，供给不足优先补最紧缺的下游，
  // 提取优先从仓储将满的上游取货（缓解其满仓压力）。
  // 1) 供给优先：总可提取量不足以满足全部需求时，按下游该 ticker 在 BURN
  //    中的剩余天数（快耗尽者优先）依次补满，而非按需求比例均摊；供给充足时
  //    各下游仍按需补满，与旧行为一致。
  // 2) 运走优先：下游需求从各上游提取时，仓储填满天数（daysUntilFull）越小的
  //    上游越先被提取（其产物优先运走），避免库存满仓。
  // 只按下游实际需求（need>0）补给；下游已充足时不再投放储备，剩余运回空间站。
  // 上游不足的部分不在此处理：组内产出不再回落 CX 采购，由下方账单剔除后按实际可得补给。
  const flows: ChainFlow[] = [];
  for (const ticker of new Set(edges.map(x => x.ticker))) {
    const tickerEdges = edges.filter(x => x.ticker === ticker);
    const upstreams = [...new Set(tickerEdges.map(x => x.from))];
    const downstreams = [...new Set(tickerEdges.map(x => x.to))];
    const avails = new Map(upstreams.map(x => [x, avail(x, ticker)] as const));
    const totalAvail = [...avails.values()].reduce((a, b) => a + b, 0);
    if (totalAvail <= 0) {
      continue;
    }
    const needs = new Map(downstreams.map(x => [x, need(x, ticker)] as const));
    const totalNeed = [...needs.values()].reduce((a, b) => a + b, 0);
    if (totalNeed <= 0) {
      continue;
    }
    // 下游紧迫度：该 ticker 在该基地 BURN 中的剩余天数（越小越急；净产出/无消耗为 ∞）。
    const tickerDaysLeft = (id: string) => {
      const mat = burns.get(id)![ticker];
      return mat === undefined ? Infinity : mat.daysLeft;
    };
    const orderedDownstreams = [...downstreams].sort((a, b) => {
      const da = tickerDaysLeft(a);
      const db = tickerDaysLeft(b);
      if (da === db) {
        return 0;
      }
      if (da === Infinity) {
        return 1;
      }
      if (db === Infinity) {
        return -1;
      }
      return da - db;
    });
    // 上游仓储紧迫度：仓储填满天数（daysUntilFull）越小越满，越优先被提取运走。
    const daysUntilFullOf = (id: string) => {
      const base = byNaturalId.get(id);
      return base?.daysUntilFull ?? Infinity;
    };
    const orderedUpstreams = [...upstreams].sort((a, b) => {
      const da = daysUntilFullOf(a);
      const db = daysUntilFullOf(b);
      if (da === db) {
        return 0;
      }
      if (da === Infinity) {
        return 1;
      }
      if (db === Infinity) {
        return -1;
      }
      return da - db;
    });
    // 上游剩余可提取量：逐下游扣减，避免同一上游被重复提取超出其 avail。
    const remainingAvail = new Map(avails);
    let remainingAvailTotal = totalAvail;
    for (const to of orderedDownstreams) {
      const needTo = needs.get(to)!;
      if (needTo <= 0) {
        continue;
      }
      const give = Math.min(needTo, remainingAvailTotal);
      if (give <= 0) {
        break;
      }
      let remainingGive = give;
      for (const from of orderedUpstreams) {
        const available = remainingAvail.get(from)!;
        if (available <= 0) {
          continue;
        }
        const amount = Math.min(available, remainingGive);
        remainingAvail.set(from, available - amount);
        remainingAvailTotal -= amount;
        remainingGive -= amount;
        flows.push({ ticker, from, to, amount });
        if (remainingGive <= 0) {
          break;
        }
      }
    }
  }

  // 每个上游基地、每个 ticker 已送下游的量，用于计算剩余运回量。
  const delivered = new Map<string, Map<string, number>>();
  for (const flow of flows) {
    const m = delivered.get(flow.from) ?? new Map<string, number>();
    m.set(flow.ticker, (m.get(flow.ticker) ?? 0) + flow.amount);
    delivered.set(flow.from, m);
  }

  // 白名单内的组内产物优先由基地提供。多船分段时由调用方传入全局集合。
  const groupProducedTickers = input.groupProducedTickers ?? new Set(producers.keys());

  // 每站 CX 账单：与基地规划派遣一致的完整账单（补给+维修），
  // 减去链上「确定输送」的量；循环的组内产物在安排回运之后再确定外购量。
  // 出发地空间站仓库已有库存的物资（含组内产物与普通补给）优先以「取货」装船，
  // 采购量在 purchaseBill 阶段扣除取货部分，避免仓库已有仍重复购买。
  const incoming = new Map<string, Map<string, number>>(); // naturalId → ticker → 输送量
  for (const flow of flows) {
    const byTicker = incoming.get(flow.to) ?? new Map<string, number>();
    byTicker.set(flow.ticker, (byTicker.get(flow.ticker) ?? 0) + flow.amount);
    incoming.set(flow.to, byTicker);
  }
  const cxResupply = new Map<string, Record<string, number>>();
  // 出发地仓库剩余库存（取货会扣减，避免重复分配）。
  const remainingOriginStock = new Map(Object.entries(input.originStock ?? {}));
  const loopReturnDemand: Record<string, number> = {};
  // 出发地「取货」明细：naturalId → ticker → 数量（装载后随行到站卸货）。
  const originPickupByStop = new Map<string, Record<string, number>>();
  // 组内产出的缺口（需求超出上游可提取量且空间站库存不足）按 ticker 汇总，用于警告。
  const producedGap = new Map<string, number>();
  for (const id of order) {
    const base = byNaturalId.get(id)!;
    const bill = { ...base.bill };
    const inc = incoming.get(id);
    if (inc) {
      for (const [ticker, amount] of inc) {
        const remaining = (bill[ticker] ?? 0) - amount;
        if (remaining > 0) {
          bill[ticker] = remaining;
        } else {
          delete bill[ticker];
        }
      }
    }
    // 循环先按完整缺口装船，再区分周转货和外购；单趟用仓库现有库存补足。
    for (const ticker of Object.keys(bill)) {
      if (!groupProducedTickers.has(ticker)) {
        continue;
      }
      const gap = bill[ticker]!;
      if (input.loop) {
        loopReturnDemand[ticker] = (loopReturnDemand[ticker] ?? 0) + gap;
        const byTicker = originPickupByStop.get(id) ?? {};
        byTicker[ticker] = gap;
        originPickupByStop.set(id, byTicker);
        continue;
      }
      const stock = remainingOriginStock.get(ticker) ?? 0;
      const pickup = Math.min(gap, stock);
      if (pickup > 0) {
        const byTicker = originPickupByStop.get(id) ?? {};
        byTicker[ticker] = pickup;
        originPickupByStop.set(id, byTicker);
        remainingOriginStock.set(ticker, stock - pickup);
        bill[ticker] = pickup;
      } else {
        delete bill[ticker];
      }
      const remaining = gap - pickup;
      if (remaining > 0) {
        producedGap.set(ticker, (producedGap.get(ticker) ?? 0) + remaining);
      }
    }
    // 空间站仓库已有库存的普通物资（非组内产出）：优先从仓库「取货」装船，
    // 不足部分才进入 CX 采购（purchaseBill 阶段按取货量扣除），避免重复购买。
    for (const ticker of Object.keys(bill)) {
      if (input.loop || groupProducedTickers.has(ticker)) {
        continue;
      }
      const stock = remainingOriginStock.get(ticker) ?? 0;
      if (stock <= 0) {
        continue;
      }
      const need = bill[ticker]!;
      const pickup = Math.min(need, stock);
      if (pickup <= 0) {
        continue;
      }
      const byTicker = originPickupByStop.get(id) ?? {};
      byTicker[ticker] = (byTicker[ticker] ?? 0) + pickup;
      originPickupByStop.set(id, byTicker);
      remainingOriginStock.set(ticker, stock - pickup);
    }
    cxResupply.set(id, bill);
  }
  // 可购数量先按航线分配，再模拟实际货舱与分站卸货。
  const remainingSupply = new Map<string, number>();
  for (const id of order) {
    const bill = cxResupply.get(id)!;
    if (input.loop || !byNaturalId.get(id)!.cxBuy) {
      continue;
    }
    for (const [ticker, amount] of Object.entries(bill)) {
      const supply = input.purchaseStock[ticker];
      if (supply === undefined) {
        continue;
      }
      const available = remainingSupply.get(ticker) ?? Math.max(0, Math.floor(supply));
      const pickup = originPickupByStop.get(id)?.[ticker] ?? 0;
      const wanted = Math.max(0, amount - pickup);
      const buy = Math.min(wanted, available);
      remainingSupply.set(ticker, available - buy);
      if (buy < wanted) {
        warnings.push(
          `「${ticker}」订单簿供应不足（可购 ${formatAmount(buy)} / 需 ${formatAmount(wanted)}），已缩减本站配送量。`,
        );
        if (pickup + buy > 0) {
          bill[ticker] = pickup + buy;
        } else {
          delete bill[ticker];
        }
      }
    }
  }

  // 循环实际可提取量：周期净余量（日产 − 日耗）加上本轮送达的自产自耗部分
  // （送达顶掉了基地自留量，不加上就会逐轮累积在基地）。
  const loopExtractable = (id: string, ticker: string) => {
    const mat = burns.get(id)![ticker];
    if (mat === undefined) {
      return 0;
    }
    const delivered = (incoming.get(id)?.get(ticker) ?? 0) + (cxResupply.get(id)?.[ticker] ?? 0);
    return Math.max(0, Math.floor(-cycleNetAmount(mat, targetDays.get(id)!) + delivered));
  };

  if (producedGap.size > 0) {
    plan.hasUnmetChainDemand = true;
  }
  for (const [ticker, gap] of producedGap) {
    warnings.push(`「${ticker}」为组内产出，缺口 ${gap} 未能由空间站库存补足，不再从 CX 采购。`);
  }

  // 最终产物提取列表语义：BSN 中配置的 ticker 是「可提取产物白名单」，
  // 只有白名单上的 ticker 才能从基地被拿走（不论是送给下游还是运回出发地）。
  // 不在白名单中的产出为中间产物，不应被搬运。
  // - 白名单 ticker 有下游边：进 flows（链上供给优先），不运回出发地。
  // - 白名单 ticker 无下游边：进 finalTickers（运回出发地）。
  // - 白名单未配置：所有产出按中间产物处理（不提取，不搬运）。
  // 有下游边的 ticker 集合（用于排除 finalTickers）。
  const chainTickers = new Set(edges.map(x => x.ticker));
  const finalTickers = new Map<string, string[]>(); // naturalId → tickers
  for (const base of bases) {
    const id = base.naturalId;
    const configured = base.products;
    if (configured === undefined || configured.length === 0) {
      continue;
    }
    // 白名单中仅保留「产出 > 0」且「无下游边」的 ticker：
    // 有下游边的走 flows（完整产业链输送），无下游边的才运回出发地。
    const burn = burns.get(id)!;
    const list: string[] = [];
    let i = 0;
    while (i < configured.length) {
      const ticker = configured[i]!;
      const mat = burn[ticker];
      if (mat === undefined || mat.output <= 0 || chainTickers.has(ticker)) {
        i++;
        continue;
      }
      list.push(ticker);
      let set: Set<string> | undefined = allowlistedProducers.get(ticker);
      if (set === undefined) {
        set = new Set<string>();
        allowlistedProducers.set(ticker, set);
      }
      set.add(id);
      i++;
    }
    if (list.length > 0) {
      finalTickers.set(id, list);
    }
  }

  // 环内循环边：反向边（上游在下游之后才到访），被拓扑排序断链。
  // 因此不回流入 flows，仅在归航时标注出「循环下游是否还需补给」。
  const backwardEdges = rawEdges.filter(
    x => position.has(x.to) && position.get(x.from)! > position.get(x.to)!,
  );
  const closureTickers = new Set(backwardEdges.map(x => x.ticker));
  const closureDownstreamNeed = new Map<string, boolean>();
  for (const ticker of closureTickers) {
    const downstreamIds = [
      ...new Set(backwardEdges.filter(e => e.ticker === ticker).map(e => e.to)),
    ];
    const totalNeed = downstreamIds.reduce((sum, id) => sum + need(id, ticker), 0);
    closureDownstreamNeed.set(ticker, totalNeed > 0);
  }

  // 沿航线先模拟必需交付，再用各段剩余舱容安排返航货物。
  let cargoWeight = 0;
  let cargoVolume = 0;
  let cargo: CargoItem[] = [];
  const { freeCapacity } = plan;

  // 把 cargo 装入船舱。两种装载策略：
  //   - 比例缩减：所有 item 按同一比例缩放（出发地装载 CX 采购物资用，超载则让用户减天数）。
  //   - 逐 item 优先：按 dest 优先级逐条装满 / 跳过（环线链上输送用，避免按比例切割导致所有
  //     下游基地都拿不到足额供应，应按下游优先度逐个装载，次要下游留待下一航次）。
  // 实现见 chain-fit.ts；这里把当前 planChainRoute 的闭包 state 灌入纯函数。
  // matWeightVolume 接受 (ticker, amount)，需要 clamp amount > 0（仓库用 0 取零除法）。
  const wv = (ticker: string, amount: number) => matWeightVolume(ticker, amount);
  const pushItemsProportional = (items: CargoItemFit[]): boolean => {
    const next: CargoState = {
      weight: cargoWeight,
      volume: cargoVolume,
      free: { weight: freeCapacity.weight, volume: freeCapacity.volume },
      cargo: cargo,
    };
    const clipped = pushItemsProportionalPure(items, next, wv);
    cargoWeight = next.weight;
    cargoVolume = next.volume;
    cargo = next.cargo;
    return clipped;
  };
  const pushItemsPrioritised = (
    items: CargoItemFit[],
    priority: Record<string, number>,
  ): boolean => {
    const next: CargoState = {
      weight: cargoWeight,
      volume: cargoVolume,
      free: { weight: freeCapacity.weight, volume: freeCapacity.volume },
      cargo: cargo,
    };
    const clipped = pushItemsPrioritisedPure(items, next, wv, priority);
    cargoWeight = next.weight;
    cargoVolume = next.volume;
    cargo = next.cargo;
    return clipped;
  };
  const trackPeak = () => {
    plan.peakLoad.weight = Math.max(plan.peakLoad.weight, cargoWeight);
    plan.peakLoad.volume = Math.max(plan.peakLoad.volume, cargoVolume);
  };

  // 出发：CX 采购物资装船（目的地为各站）。
  const initialItems: CargoItem[] = [];
  for (const [id, bill] of cxResupply) {
    for (const [ticker, amount] of Object.entries(bill)) {
      if (amount > 0) {
        initialItems.push({ ticker, amount, dest: id });
      }
    }
  }
  {
    let weight = 0;
    let volume = 0;
    for (const item of initialItems) {
      const totals = matWeightVolume(item.ticker, item.amount);
      weight += totals.weight;
      volume += totals.volume;
    }
    if (weight > freeCapacity.weight || volume > freeCapacity.volume) {
      plan.overCapacity = true;
      warnings.push('出发地采购物资超出船舱剩余载量，请减少天数或换大船。');
    }
  }
  pushItemsProportional(initialItems);
  trackPeak();
  // 出发时载重（装船后、飞首站前）。
  plan.loadOnDeparture = { weight: cargoWeight, volume: cargoVolume };

  const stops: ChainStopPlan[] = [];
  const returnPickups: Pick<CargoItem, 'ticker' | 'amount'>[][] = [];
  for (const id of order) {
    const base = byNaturalId.get(id)!;
    const stop: ChainStopPlan = {
      naturalId: id,
      planetName: base.planetName || id,
      days: targetDays.get(id)!,
      cxBuy: base.cxBuy,
      unloadCx: {},
      unloadChain: new Map(),
      load: new Map(),
      returnLoad: {},
      clipped: false,
      loadOnArrival: { weight: 0, volume: 0 },
      loadOnDeparture: { weight: 0, volume: 0 },
    };

    // 到站卸货：目的地为本站的舱内货物。
    const unloaded: CargoItem[] = [];
    const remaining: CargoItem[] = [];
    for (const item of cargo) {
      if (item.dest === id && item.amount > 0) {
        unloaded.push(item);
      } else {
        remaining.push(item);
      }
    }
    cargo = remaining;
    for (const item of unloaded) {
      const { weight, volume } = matWeightVolume(item.ticker, item.amount);
      cargoWeight -= weight;
      cargoVolume -= volume;
    }
    // 到站卸货后、提取前的舱载。
    stop.loadOnArrival = { weight: cargoWeight, volume: cargoVolume };

    // 按来源归并卸货明细（CX 采购 or 上游输送）。
    for (const item of unloaded) {
      if (item.from === undefined) {
        stop.unloadCx[item.ticker] = (stop.unloadCx[item.ticker] ?? 0) + item.amount;
      } else {
        const fromName = byNaturalId.get(item.from)?.planetName || item.from;
        const existing = stop.unloadChain.get(item.ticker);
        if (existing) {
          existing.amount += item.amount;
          if (!existing.from.includes(fromName)) {
            existing.from = `${existing.from}、${fromName}`;
          }
        } else {
          stop.unloadChain.set(item.ticker, { amount: item.amount, from: fromName });
        }
      }
    }
    // 第一遍只模拟送往下游的必需货物，返航货物在第二遍分配。
    const chainPickup: CargoItem[] = [];
    for (const flow of flows) {
      if (flow.from === id && flow.amount > 0) {
        chainPickup.push({ ticker: flow.ticker, amount: flow.amount, from: id, dest: flow.to });
      }
    }
    const finalPickup: Pick<CargoItem, 'ticker' | 'amount'>[] = [];
    const returnTickers = input.loop
      ? [...new Set(base.products)].filter(ticker => groupProducedTickers.has(ticker))
      : (finalTickers.get(id) ?? []);
    for (const ticker of returnTickers) {
      // 单趟：最终产物装尽到港时预计库存（含飞行期间新增产出），不扣自用预留。
      // 循环：只提取 周期 × BURN 日产（扣未覆盖自用），不动基地现有库存，
      // 同一批货按固定数量重复装卸。
      const amount = input.loop
        ? Math.max(0, loopExtractable(id, ticker) - (delivered.get(id)?.get(ticker) ?? 0))
        : Math.max(0, Math.floor(projectedInventory(burns.get(id)![ticker], ticker, id)));
      if (amount > 0) {
        finalPickup.push({ ticker, amount });
      }
    }
    // 有前向下游边的产物：已按需补给下游（flows），剩余可提取量运回空间站。
    // 遍历「所有下游边」而非仅正向 flows——下游已充足（need=0）时流量为 0，
    // 但产物仍有可提取余量，应运回空间站；否则会卡在基地既不送下游也不运回。
    for (const ticker of input.loop
      ? []
      : new Set(edges.filter(f => f.from === id).map(f => f.ticker))) {
      const sent = delivered.get(id)?.get(ticker) ?? 0;
      const extractable = avail(id, ticker);
      const surplus = Math.max(0, extractable - sent);
      if (surplus > 0) {
        finalPickup.push({ ticker, amount: surplus });
      }
    }

    // 阶段 1:链输送（按下游优先度逐条装满，不足则裁到剩余舱容）。
    // 优先度按 ticker 在目的地基地 BURN 中的剩余天数（daysLeft）升序排序——
    // 与 flow 规划阶段用的口径一致，确保链上输送的紧迫度排序在装载阶段也保持。
    const chainPickupPriority: Record<string, number> = {};
    {
      let rank = 0;
      for (const item of chainPickup) {
        if (chainPickupPriority[item.dest] === undefined) {
          const mat = burns.get(item.dest);
          chainPickupPriority[item.dest] =
            mat && mat[item.ticker] !== undefined ? mat[item.ticker]!.daysLeft : rank;
          rank++;
        }
      }
    }
    const chainClipped = pushItemsPrioritised(chainPickup, chainPickupPriority);
    for (const item of chainPickup) {
      if (item.amount <= 0) {
        continue;
      }
      const to = byNaturalId.get(item.dest)?.planetName || item.dest;
      const existing = stop.load.get(item.ticker);
      if (existing) {
        existing.amount += item.amount;
        if (!existing.to.includes(to)) {
          existing.to = `${existing.to}、${to}`;
        }
      } else {
        stop.load.set(item.ticker, { amount: item.amount, to });
      }
    }

    if (chainClipped) {
      plan.hasUnmetChainDemand = true;
      warnings.push(
        `「${stop.planetName}」链上输送超出船舱剩余载量，按下游优先度逐条截断（次要下游留待下航次）。`,
      );
    }
    stop.clipped = chainClipped;
    trackPeak();
    stop.loadOnDeparture = { weight: cargoWeight, volume: cargoVolume };
    stops.push(stop);
    returnPickups.push(finalPickup);
  }

  // 返航货物一直留在船上，只能使用从本站到归航期间每段都空闲的舱容。
  const returnCapacity = stops.map(stop => ({
    weight: freeCapacity.weight - stop.loadOnDeparture.weight,
    volume: freeCapacity.volume - stop.loadOnDeparture.volume,
  }));
  function reserveReturn(index: number, ticker: string, requested: number) {
    const unit = matWeightVolume(ticker, 1);
    let amount = requested;
    for (let i = index; i < returnCapacity.length; i++) {
      const capacity = returnCapacity[i]!;
      if (capacity.weight <= 0 || capacity.volume <= 0) {
        return 0;
      }
      if (unit.weight > 0) {
        amount = Math.min(amount, Math.floor(capacity.weight / unit.weight));
      }
      if (unit.volume > 0) {
        amount = Math.min(amount, Math.floor(capacity.volume / unit.volume));
      }
    }
    if (amount <= 0) {
      return 0;
    }
    for (let i = index; i < returnCapacity.length; i++) {
      const capacity = returnCapacity[i]!;
      capacity.weight -= unit.weight * amount;
      capacity.volume -= unit.volume * amount;
    }
    const stop = stops[index]!;
    plan.finalUnload[ticker] = (plan.finalUnload[ticker] ?? 0) + amount;
    stop.returnLoad[ticker] = (stop.returnLoad[ticker] ?? 0) + amount;
    const existing = stop.load.get(ticker);
    if (existing === undefined) {
      stop.load.set(ticker, { amount, to: '回出发地' });
    } else {
      existing.amount += amount;
      if (!existing.to.includes('回出发地')) {
        existing.to += '、回出发地';
      }
    }
    return amount;
  }

  if (input.loop) {
    const returned: Record<string, number> = {};
    plan.loopOriginReturn = returned;
    const outstanding = { ...loopReturnDemand };
    // 从靠近归航的站开始安排周转货物，缩短它们占用舱容的航段。
    for (let index = stops.length - 1; index >= 0; index--) {
      for (const item of returnPickups[index]!) {
        const needed = outstanding[item.ticker] ?? 0;
        if (needed > 0) {
          outstanding[item.ticker] =
            needed - reserveReturn(index, item.ticker, Math.min(needed, item.amount));
        }
      }
    }
    for (const [ticker, missed] of Object.entries(outstanding)) {
      const amount = loopReturnDemand[ticker]! - missed;
      if (amount > 0) {
        returned[ticker] = amount;
        plan.originPickup[ticker] = amount;
      }
      if (missed > 0) {
        plan.purchaseBill[ticker] = missed;
        warnings.push(
          `出发地「${ticker}」每轮回运 ${formatAmount(amount)}，从外部补给 ${formatAmount(missed)}。`,
        );
      }
    }
  }

  let returnWeight = 0;
  let returnVolume = 0;
  for (const [index, stop] of stops.entries()) {
    let finalClipped = false;
    for (const item of returnPickups[index]!) {
      const remaining = item.amount - (stop.returnLoad[item.ticker] ?? 0);
      const unshipped = remaining - reserveReturn(index, item.ticker, remaining);
      if (unshipped > 0) {
        finalClipped = true;
        if (input.loop) {
          warnings.push(
            `「${stop.planetName}」${item.ticker} 受返航舱容限制，每轮留存 ${formatAmount(unshipped)}。`,
          );
        }
      }
    }
    if (finalClipped) {
      stop.clipped = true;
      if (!input.loop) {
        warnings.push(`「${stop.planetName}」最终产物受舱容限制，部分未装上船。`);
      }
    }
    stop.loadOnArrival.weight += returnWeight;
    stop.loadOnArrival.volume += returnVolume;
    for (const [ticker, amount] of Object.entries(stop.returnLoad)) {
      const { weight, volume } = matWeightVolume(ticker, amount);
      returnWeight += weight;
      returnVolume += volume;
    }
    stop.loadOnDeparture.weight += returnWeight;
    stop.loadOnDeparture.volume += returnVolume;
    plan.peakLoad.weight = Math.max(plan.peakLoad.weight, stop.loadOnDeparture.weight);
    plan.peakLoad.volume = Math.max(plan.peakLoad.volume, stop.loadOnDeparture.volume);
  }

  // 归航前舱载（最后站离开后、卸最终产物前）。
  plan.loadOnReturn = { weight: cargoWeight + returnWeight, volume: cargoVolume + returnVolume };

  // 汇总装船总量和各站启用的 CX 采购量。循环周转货的外购差额已在回运分配时计入。
  for (const stop of stops) {
    for (const [ticker, amount] of Object.entries(stop.unloadCx)) {
      if (amount > 0) {
        plan.cxBill[ticker] = (plan.cxBill[ticker] ?? 0) + amount;
        const pickup = Math.min(amount, originPickupByStop.get(stop.naturalId)?.[ticker] ?? 0);
        if (pickup > 0 && !input.loop) {
          plan.originPickup[ticker] = (plan.originPickup[ticker] ?? 0) + pickup;
        }
        if (stop.cxBuy) {
          const buy = amount - pickup;
          if (buy > 0) {
            plan.purchaseBill[ticker] = (plan.purchaseBill[ticker] ?? 0) + buy;
          }
        }
      }
    }
  }

  // 运回空间站产物标注。
  plan.finalUnloadNotes = {};
  for (const ticker of Object.keys(plan.finalUnload)) {
    if (closureTickers.has(ticker)) {
      plan.finalUnloadNotes[ticker] = closureDownstreamNeed.get(ticker)
        ? '循环下游需补给（本轮运回，下轮经仓库补给）'
        : '循环下游已充足（运回空间站）';
    } else if (chainTickers.has(ticker)) {
      plan.finalUnloadNotes[ticker] = '下游已充足（剩余运回空间站）';
    } else {
      plan.finalUnloadNotes[ticker] = '无下游产业链（运回空间站）';
    }
  }

  // 过滤本轮没有任何实际操作的基地，避免航线出现空停靠点；保留原因供规划界面说明。
  // 「操作」只统计三类本站动作：CX 卸货、链上卸货、提取货物。
  const filteredStops: ChainFilteredStop[] = [];
  plan.stops = stops.filter(stop => {
    const hasCxUnload = Object.keys(stop.unloadCx).length > 0;
    const hasChainUnload = stop.unloadChain.size > 0;
    const hasLoad = stop.load.size > 0;
    if (hasCxUnload || hasChainUnload || hasLoad) {
      return true;
    }
    const operations: string[] = [];
    if (!hasCxUnload) {
      operations.push('无 CX 卸货');
    }
    if (!hasChainUnload) {
      operations.push('无链上卸货');
    }
    if (!hasLoad) {
      operations.push('无提取货物');
    }
    filteredStops.push({
      naturalId: stop.naturalId,
      planetName: stop.planetName,
      reason: `${operations.join('、')}（本站无操作）`,
    });
    return false;
  });
  if (filteredStops.length > 0) {
    plan.filteredStops = filteredStops;
  }
  if (input.loop) {
    // 满载分摊按全部基地的净日耗加权（自给基地 bundle 为 0、不占分摊）。
    plan.fullLoadUsableDays = fullLoadDays;
  }
  return plan;
}
