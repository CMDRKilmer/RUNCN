import { getPlanetBurn } from '@src/core/burn';
import type { BurnValues } from '@src/core/burn';
import { getBaseProducts } from '@src/core/base-products';
import {
  clampTargetDays as clampTargetDaysUtil,
  getSuppliesCap,
} from '@src/features/XIT/FLEET/supplies-cap';
import { comparePlanets } from '@src/core/game-lookups';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { createId } from '@src/store/create-id';
import {
  combinedBaseBill,
  type DispatchBaseConfig,
  type DispatchShip,
} from '@src/features/XIT/FLEET/utils';

// 出发地标记（最终产物运回出发地 CX）。
export const ORIGIN_DEST = '__ORIGIN__';

export interface ChainPlannerBase {
  siteId: string;
  naturalId: string;
  planetName: string;
  site: PrunApi.Site;
  config: DispatchBaseConfig;
}

// 产业链输送：上游基地 → 下游基地（按 ticker）。
export interface ChainFlow {
  ticker: string;
  from: string;
  to: string;
  amount: number;
}

// 舱内一件货物：装船于某站，目的地为下游站点或出发地。
interface CargoItem {
  ticker: string;
  amount: number;
  // 装船站点（undefined = 出发地 CX 采购）。
  from?: string;
  // 目的站点（ORIGIN_DEST = 回出发地）。
  dest: string;
}

export interface ChainStopPlan {
  naturalId: string;
  planetName: string;
  days: number;
  // 主界面「购买」开关：false 的基地账单只从出发地仓库装船，不在 CX 下单。
  cxBuy: boolean;
  // 卸货（船→基地）：CX 采购的非链物资。
  unloadCx: Record<string, number>;
  // 卸货（船→基地）：上游基地输送来的链上物资。ticker → { 数量, 来源星球名 }。
  unloadChain: Map<string, { amount: number; from: string }>;
  // 提取（基地→船）：本站产物。ticker → { 数量, 去向标签 }。
  load: Map<string, { amount: number; to: string }>;
  // 提取被舱容缩减过。
  clipped: boolean;
  // 到站卸货后、提取前的舱载。
  loadOnArrival: { weight: number; volume: number };
  // 到站卸货+提取后的舱载（离开本站时）。
  loadOnDeparture: { weight: number; volume: number };
}

export interface ChainPlan {
  // 出发地站点 naturalId（如 AI1），用于归航触发器匹配。
  originNaturalId: string;
  stops: ChainStopPlan[];
  // 归航时在出发地卸下的最终产物。
  finalUnload: Record<string, number>;
  // 出发地装船总账单（所有站账单合并，含未开启「购买」的基地）。
  cxBill: Record<string, number>;
  // 出发地在 CX 实际下单的账单（仅开启「购买」的基地）。
  purchaseBill: Record<string, number>;
  warnings: string[];
  peakLoad: { weight: number; volume: number };
  freeCapacity: { weight: number; volume: number };
  // 飞船总舱容（不是剩余）。
  capacity: { weight: number; volume: number };
  // 出发时舱载（装船后、飞首站前）。
  loadOnDeparture: { weight: number; volume: number };
  // 归航前舱载（最后站离开后、卸最终产物前）。
  loadOnReturn: { weight: number; volume: number };
  overCapacity: boolean;
}

function matWeightVolume(ticker: string, amount: number) {
  const mat = materialsStore.getByTicker(ticker);
  return {
    weight: mat ? mat.weight * amount : 0,
    volume: mat ? mat.volume * amount : 0,
  };
}

// 目标天数：与 computeResupplyBill 相同的 suppliesCapDays 钳制（见 supplies-cap.ts）。
function clampTargetDays(base: ChainPlannerBase) {
  return clampTargetDaysUtil(base.config.days, getSuppliesCap(base.site));
}

/**
 * 规划产业链环线：
 * 1. 用各基地 burn（产出/消耗/库存）推断上下游边；
 * 2. 拓扑排序定航线（上游先到，循环依赖断链并警告）；
 * 3. 按目标天数平衡各链上物资运量（多上游按库存比例分摊）；
 * 4. 沿航线模拟舱容，超载按比例缩减提取量。
 * 所有选中基地均为环线站点（含 CX 采购与卸货），无链关系的基地
 * 按字母序混入航线，其产物视为最终产物运回出发地。
 * 数据未加载时返回 undefined。
 */
export function planChainRoute(input: {
  ship: DispatchShip;
  bases: ChainPlannerBase[];
}): ChainPlan | undefined {
  const { ship, bases } = input;
  if (!ship.cargoStore) {
    return undefined;
  }

  const warnings: string[] = [];

  // 各基地 burn 数据（任一未加载则整体视为加载中）。
  const burns = new Map<string, BurnValues>();
  for (const base of bases) {
    const burn = getPlanetBurn(base.siteId);
    if (!burn) {
      return undefined;
    }
    burns.set(base.naturalId, burn.burn);
  }

  // 预读白名单：BSN 中配置的 ticker 是「可提取产物白名单」，
  // 只有白名单上的 ticker 才能被提取（送下游或运回出发地）。
  // producer 推断仅考虑白名单 ticker（不白名单 = 中间产物，不参与搬运）。
  const allowlistedProducers = new Map<string, Set<string>>(); // ticker → bases with it in BSN
  for (const base of bases) {
    const configured = getBaseProducts(base.siteId);
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
  const consumers = new Map<string, string[]>();
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
  for (const site of sitesStore.all.value ?? []) {
    const burn = getPlanetBurn(site.siteId);
    if (!burn) {
      continue;
    }
    const naturalId = getEntityNaturalIdFromAddress(site.address);
    if (!naturalId) {
      continue;
    }
    for (const [ticker, mat] of Object.entries(burn.burn)) {
      if (mat.input > 0 || mat.workforce > 0) {
        const list = consumers.get(ticker) ?? [];
        if (!list.includes(naturalId)) {
          list.push(naturalId);
        }
        consumers.set(ticker, list);
      }
    }
    // 补充：burn 过滤掉 started 订单的 input，导致正在运行的 PCB 生产线
    // 不会出现在 burn.input 里。直接从 production orders 读所有 input 物料
    // （不限于未启动订单），合并入 consumer 集合，避免 ticker 被误判为最终产物。
    const lines = productionStore.getBySiteId(site.siteId);
    if (lines) {
      for (const line of lines) {
        for (const order of line.orders) {
          for (const mat of order.inputs ?? []) {
            const ticker = mat.material.ticker;
            const list = consumers.get(ticker) ?? [];
            if (!list.includes(naturalId)) {
              list.push(naturalId);
            }
            consumers.set(ticker, list);
          }
        }
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
    originNaturalId:
      getEntityNaturalIdFromAddress(ship.ship.address ?? undefined) ?? ship.exchangeCode,
    stops: [],
    finalUnload: {},
    cxBill: {},
    purchaseBill: {},
    warnings,
    peakLoad: { weight: 0, volume: 0 },
    freeCapacity: {
      weight: ship.cargoStore.weightCapacity - ship.cargoStore.weightLoad,
      volume: ship.cargoStore.volumeCapacity - ship.cargoStore.volumeLoad,
    },
    capacity: {
      weight: ship.cargoStore.weightCapacity,
      volume: ship.cargoStore.volumeCapacity,
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

  // 目标天数（所有选中基地，含无链关系基地的采购补给）。
  const targetDays = new Map<string, number>();
  for (const base of bases) {
    targetDays.set(base.naturalId, clampTargetDays(base));
  }
  // need: 下游 ticker 需求 = 目标天数 × 日耗（原料+消耗品）− 库存。
  const need = (id: string, ticker: string) => {
    const mat = burns.get(id)![ticker];
    return Math.max(
      0,
      Math.ceil(targetDays.get(id)! * (mat.input + mat.workforce) - mat.inventory),
    );
  };
  // avail: 上游可提取 = 库存 − 自用预留（目标天数 × 自身日耗）。
  const avail = (id: string, ticker: string) => {
    const mat = burns.get(id)![ticker];
    return Math.max(
      0,
      Math.floor(mat.inventory - targetDays.get(id)! * (mat.input + mat.workforce)),
    );
  };

  // 按 ticker 平衡：多下游共享多上游时，按需求比例分配总可提取量，
  // 再按上游库存比例分摊到各条边。
  // 完整产业链语义：只要有下游边，即使下游当前不缺（need=0），
  // 也把上游可提取量送下去（作为产业链储备），由下方 CX 账单扣减避免重复采购。
  // 上游不足的部分不在此处理，由下方账单扣减后回落到 CX 采购。
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
    for (const to of downstreams) {
      const needTo = needs.get(to)!;
      // 有需求按需求分配，无需求按均分（完整产业链储备）。
      const share =
        totalNeed > 0
          ? Math.min(needTo, (totalAvail * needTo) / totalNeed)
          : totalAvail / downstreams.length;
      for (const from of upstreams) {
        const amount = Math.floor((avails.get(from)! * share) / totalAvail);
        if (amount > 0) {
          flows.push({ ticker, from, to, amount });
        }
      }
    }
  }

  // 每站 CX 账单：与基地规划派遣一致的完整账单（补给+维修），
  // 再减去链上「确定输送」的量——上游不足的缺口自动回落到 CX 采购，
  // 避免整 ticker 剔除导致下游缺料。
  const incoming = new Map<string, Map<string, number>>(); // naturalId → ticker → 输送量
  for (const flow of flows) {
    const byTicker = incoming.get(flow.to) ?? new Map<string, number>();
    byTicker.set(flow.ticker, (byTicker.get(flow.ticker) ?? 0) + flow.amount);
    incoming.set(flow.to, byTicker);
  }
  const cxResupply = new Map<string, Record<string, number>>();
  for (const id of order) {
    const base = byNaturalId.get(id)!;
    const bill = combinedBaseBill(id, base.config, base.site) ?? {};
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
    cxResupply.set(id, bill);
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
    const configured = getBaseProducts(base.siteId);
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

  // 沿航线模拟舱容：到站先卸（含链输送），再提取（链输送 + 最终产物），
  // 超载按比例缩减提取量并同步削减下游到货。
  let cargoWeight = 0;
  let cargoVolume = 0;
  let cargo: CargoItem[] = [];
  const { freeCapacity } = plan;

  const pushItems = (items: CargoItem[]) => {
    if (items.length === 0) {
      return false;
    }
    let loadWeight = 0;
    let loadVolume = 0;
    for (const item of items) {
      const { weight, volume } = matWeightVolume(item.ticker, item.amount);
      loadWeight += weight;
      loadVolume += volume;
    }
    let scale = 1;
    if (loadWeight > freeCapacity.weight - cargoWeight) {
      scale = Math.min(scale, (freeCapacity.weight - cargoWeight) / loadWeight);
    }
    if (loadVolume > freeCapacity.volume - cargoVolume) {
      scale = Math.min(scale, (freeCapacity.volume - cargoVolume) / loadVolume);
    }
    if (scale <= 0) {
      return true;
    }
    for (const item of items) {
      item.amount = Math.floor(item.amount * scale);
    }
    cargoWeight += loadWeight * scale;
    cargoVolume += loadVolume * scale;
    cargo = [...cargo, ...items];
    return scale < 1;
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
  pushItems(initialItems);
  trackPeak();
  // 出发时载重（装船后、飞首站前）。
  plan.loadOnDeparture = { weight: cargoWeight, volume: cargoVolume };

  const stops: ChainStopPlan[] = [];
  for (const id of order) {
    const base = byNaturalId.get(id)!;
    const stop: ChainStopPlan = {
      naturalId: id,
      planetName: base.planetName || id,
      days: targetDays.get(id)!,
      cxBuy: base.config.cxBuy,
      unloadCx: {},
      unloadChain: new Map(),
      load: new Map(),
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

    // 提取：拆两阶段。
    //   阶段 1：链输送（送下游）——受舱容约束，超载按比例缩减、警告。
    //   阶段 2：最终产物（回出发地）——不裁剪，超载仅警告并截到裁点之前的部分（不缩减全部）。
    // 这样保证船尽量装满产物运回，下游补给也不会被过裁。
    const chainPickup: CargoItem[] = [];
    for (const flow of flows) {
      if (flow.from === id && flow.amount > 0) {
        chainPickup.push({ ticker: flow.ticker, amount: flow.amount, from: id, dest: flow.to });
      }
    }
    const finalPickup: CargoItem[] = [];
    for (const ticker of finalTickers.get(id) ?? []) {
      // 最终产物装尽全部库存：不扣自用预留（自用是该基地 burn 的事）。
      // 链上 flows 仍按 avail（扣自用）避免抽空基地导致断粮。
      const mat = burns.get(id)![ticker];
      const amount = Math.max(0, Math.floor(mat.inventory));
      if (amount > 0) {
        finalPickup.push({ ticker, amount, from: id, dest: ORIGIN_DEST });
      }
    }

    // 阶段 1:链输送（超载按比例缩减）。
    const chainClipped = pushItems(chainPickup);
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

    // 阶段 2:最终产物。逐 ticker 尝试 push,装不下则跳过该 ticker 并警告,
    // 让下一站的产物有机会被装上,不一次性裁掉全部。
    let finalClipped = false;
    for (const item of finalPickup) {
      const remainingW = freeCapacity.weight - cargoWeight;
      const remainingV = freeCapacity.volume - cargoVolume;
      if (remainingW <= 0 || remainingV <= 0) {
        finalClipped = true;
        continue;
      }
      const { weight: itemW, volume: itemV } = matWeightVolume(item.ticker, 1);
      const totalW = itemW * item.amount;
      const totalV = itemV * item.amount;
      // 若整批装不下,则装尽剩余空间(逐件填充以保留整数),仅最后一个 ticker 可能截断。
      let amount = item.amount;
      if (totalW > remainingW && itemW > 0) {
        amount = Math.min(amount, Math.floor(remainingW / itemW));
      }
      if (totalV > remainingV && itemV > 0) {
        amount = Math.min(amount, Math.floor(remainingV / itemV));
      }
      if (amount <= 0) {
        finalClipped = true;
        continue;
      }
      item.amount = amount;
      const { weight, volume } = matWeightVolume(item.ticker, amount);
      cargoWeight += weight;
      cargoVolume += volume;
      cargo = [...cargo, item];
      const existing = stop.load.get(item.ticker);
      if (existing) {
        existing.amount += amount;
        if (!existing.to.includes('回出发地')) {
          existing.to = `${existing.to}、回出发地`;
        }
      } else {
        stop.load.set(item.ticker, { amount, to: '回出发地' });
      }
      if (amount < item.amount || totalW > remainingW || totalV > remainingV) {
        finalClipped = true;
      }
    }

    stop.clipped = chainClipped || finalClipped;
    if (chainClipped) {
      warnings.push(`「${stop.planetName}」链上输送超出船舱剩余载量，已按比例缩减。`);
    }
    if (finalClipped) {
      warnings.push(`「${stop.planetName}」最终产物受舱容限制，部分未装上船。`);
    }

    trackPeak();
    // 卸货+提取后舱载（离开本站时）。
    stop.loadOnDeparture = { weight: cargoWeight, volume: cargoVolume };
    stops.push(stop);
  }

  // 归航前舱载（最后站离开后、卸最终产物前）。
  plan.loadOnReturn = { weight: cargoWeight, volume: cargoVolume };

  // 归航：卸下最终产物。
  for (const item of cargo) {
    if (item.dest === ORIGIN_DEST && item.amount > 0) {
      plan.finalUnload[item.ticker] = (plan.finalUnload[item.ticker] ?? 0) + item.amount;
    }
  }

  // 汇总装船总账单（全部站）与 CX 采购账单（仅开启「购买」的站）。
  for (const stop of stops) {
    for (const [ticker, amount] of Object.entries(stop.unloadCx)) {
      if (amount > 0) {
        plan.cxBill[ticker] = (plan.cxBill[ticker] ?? 0) + amount;
        if (stop.cxBuy) {
          plan.purchaseBill[ticker] = (plan.purchaseBill[ticker] ?? 0) + amount;
        }
      }
    }
  }

  plan.stops = stops;
  return plan;
}

// 触发器 + 对应操作包：到港执行本站「卸货→提取→飞往下一站」。
export interface ChainStopPackage {
  pkg: UserData.ActionPackageData;
  trigger: UserData.TriggerData;
}

export interface ChainActionPlan {
  // 出发地主包（暂存至 XIT FLEETACT 执行）。
  mainPkg: UserData.ActionPackageData;
  // 各基地站点包 + 触发器（写入 userData，由 FLIGHT_ENDED 触发）。
  stopPkgs: ChainStopPackage[];
  // 归航包 + 触发器（最终产物卸至出发地仓库，可能为空）。
  finalPkg: ChainStopPackage | undefined;
}

/**
 * 把环线计划转成 ACT 操作包与 TRIGGER 触发器数据：
 * - 主包：加油 + 按基地材料组 + CX 采购（仅开启「购买」的基地）+ 装船 +
 *   飞往第一站，结构与基地规划派遣包一致；
 * - 每站包：卸货（船→基地）+ 提取（基地→船）+ 飞往下一站（末站飞回出发地）；
 * - 归航包：最终产物卸至出发地仓库。
 * 卸货/提取 MTRA 始终成对存在（即使某侧为空），保证 OPEN SFC 能从「提取」
 * 动作解析出飞船。空的 MTRA 组会立即完成，无副作用。
 */
// XIT 命令参数仅接受 ASCII（与 BPC/CART 生成 ACT 同款约束）：包名会拼进
// `XIT ACT_${name}` 命令，含中文 / `()'"&` 等符号时 PrUn 端解析失败（提示无效指令）。
// 仅保留 ASCII 字母 / 数字 / hyphen，其余符号与空白折叠为单个空格。
export function sanitizeActName(name: string): string {
  return name
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildChainActionPackages(
  ship: DispatchShip,
  plan: ChainPlan,
  options: { autoLaunch?: boolean; triggerMode?: UserData.TriggerMode } = {},
): ChainActionPlan | undefined {
  if (!ship.warehouseStore || !ship.cargoStore) {
    return undefined;
  }
  // 船名净化后仍为空（如中文船名）时回退到注册号，保证包名非空。
  const shipName =
    sanitizeActName(ship.ship.name ?? ship.ship.registration) || ship.ship.registration;
  const loadGroupName = `装载 ${shipName}`;
  const originWarehouse = serializeStorage(ship.warehouseStore);
  const shipCargo = serializeStorage(ship.cargoStore);

  const actions: UserData.ActionData[] = [];
  const groups: UserData.MaterialGroupData[] = [];

  // 每个有账单的基地一个材料组（与基地规划派遣包一致，便于在 ACT 中查看调整）。
  for (const stop of plan.stops) {
    if (Object.keys(stop.unloadCx).length > 0) {
      groups.push({
        type: 'Manual',
        name: stop.planetName || stop.naturalId,
        planet: stop.naturalId,
        materials: stop.unloadCx,
      });
    }
  }
  // 注：环线模式不再生成加油动作。用户需要加油请在基地规划模式（Plan）操作，
  // 或手动在 ACT 中调整生成的包。

  // 采购：仅合并开启「购买」的基地账单；未开启的基地账单仍会装船（来自仓库库存）。
  if (Object.keys(plan.purchaseBill).length > 0) {
    const buyGroupName = `购买 ${ship.exchangeCode}`;
    groups.push({ type: 'Manual', name: buyGroupName, materials: plan.purchaseBill });
    actions.push({
      type: 'CX Buy',
      name: buyGroupName,
      group: buyGroupName,
      exchange: ship.exchangeCode,
      useCXInv: true,
    });
  }

  groups.push({ type: 'Manual', name: loadGroupName, materials: plan.cxBill });

  actions.push({
    type: 'MTRA',
    name: loadGroupName,
    group: loadGroupName,
    origin: originWarehouse,
    dest: shipCargo,
  });

  const firstStop = plan.stops[0];
  if (firstStop !== undefined) {
    actions.push({
      type: 'OPEN SFC',
      name: `飞往 ${firstStop.planetName}`,
      destination: firstStop.naturalId,
      shipSourceAction: loadGroupName,
    });
    if (options.autoLaunch) {
      actions.push({
        type: 'DEPART',
        name: `出发 ${firstStop.planetName}`,
        registration: ship.ship.registration,
      });
    }
  }

  const mainPkg: UserData.ActionPackageData = {
    global: { name: `Chain ${shipName}` },
    groups,
    actions,
  };

  const makeTrigger = (name: string, pkgName: string, planet: string): UserData.TriggerData => ({
    id: createId(),
    name,
    enabled: true,
    event: { type: 'FLIGHT_ENDED', ship: ship.ship.registration, planet },
    packageName: pkgName,
    mode: options.triggerMode ?? 'CONFIRM',
    cooldownMin: 60,
    createdAt: Date.now(),
    autoDelete: true,
  });

  const stopPkgs: ChainStopPackage[] = [];
  for (let i = 0; i < plan.stops.length; i++) {
    const stop = plan.stops[i]!;
    // 星球名净化后为空（如中文/含符号名）时回退到 naturalId，保证包名可被 ACT 命令解析。
    const stopLabel = sanitizeActName(stop.planetName || stop.naturalId) || stop.naturalId;
    const pkgName = `${stopLabel} Loop ${shipName}`;
    const baseStore = `${stop.planetName} Base`;

    const unload: Record<string, number> = { ...stop.unloadCx };
    for (const [ticker, entry] of stop.unloadChain) {
      unload[ticker] = (unload[ticker] ?? 0) + entry.amount;
    }
    const load: Record<string, number> = {};
    for (const [ticker, entry] of stop.load) {
      load[ticker] = entry.amount;
    }

    const next = plan.stops[i + 1];
    const departAction: UserData.ActionData | undefined = options.autoLaunch
      ? {
          type: 'DEPART',
          name: next !== undefined ? `出发 ${next.planetName}` : `出发 ${plan.originNaturalId}`,
          registration: ship.ship.registration,
        }
      : undefined;
    const pkg: UserData.ActionPackageData = {
      global: { name: pkgName },
      autoDelete: true,
      groups: [
        { type: 'Manual', name: '卸货', materials: unload },
        { type: 'Manual', name: '提取', materials: load },
      ],
      actions: [
        {
          type: 'MTRA',
          name: '卸货',
          group: '卸货',
          origin: shipCargo,
          dest: baseStore,
        },
        {
          type: 'MTRA',
          name: '提取',
          group: '提取',
          origin: baseStore,
          dest: shipCargo,
        },
        {
          type: 'OPEN SFC',
          name: next !== undefined ? `飞往 ${next.planetName}` : `飞往 ${plan.originNaturalId}`,
          destination: next !== undefined ? next.naturalId : plan.originNaturalId,
          shipSourceAction: '提取',
        },
        ...(departAction !== undefined ? [departAction] : []),
      ],
    };
    stopPkgs.push({
      pkg,
      trigger: makeTrigger(`${stop.planetName} 环线站`, pkgName, stop.naturalId),
    });
  }

  let finalPkg: ChainStopPackage | undefined;
  if (Object.keys(plan.finalUnload).length > 0) {
    const pkgName = `Chain Return ${shipName}`;
    finalPkg = {
      pkg: {
        global: { name: pkgName },
        autoDelete: true,
        groups: [{ type: 'Manual', name: '卸货', materials: plan.finalUnload }],
        actions: [
          {
            type: 'MTRA',
            name: '卸货',
            group: '卸货',
            origin: shipCargo,
            dest: originWarehouse,
          },
        ],
      },
      trigger: makeTrigger(`${plan.originNaturalId} 归航卸货`, pkgName, plan.originNaturalId),
    };
  }

  return { mainPkg, stopPkgs, finalPkg };
}
