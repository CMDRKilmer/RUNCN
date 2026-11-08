import { getPlanetBurn } from '@src/core/burn';
import type { BurnValues, MaterialBurn } from '@src/core/burn';
import { getBaseProducts } from '@src/core/base-products';
import {
  clampTargetDays as clampTargetDaysUtil,
  getSuppliesCap,
} from '@src/features/XIT/FLEET/supplies-cap';
import { comparePlanets } from '@src/core/game-lookups';
import { getBaseStorageAnalysis } from '@src/core/storage-analysis';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { gameNow } from '@src/infrastructure/fio/orbit';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import {
  pushItemsPrioritised as pushItemsPrioritisedPure,
  pushItemsProportional as pushItemsProportionalPure,
  type CargoItem as CargoItemFit,
  type CargoState,
} from '@src/features/XIT/FLEET/chain-fit';
import { fixed0 } from '@src/utils/format';
import { combinedBaseBill } from '@src/features/XIT/FLEET/utils';

import {
  ORIGIN_DEST,
  type ChainPlannerBase,
  type ChainCapacity,
  type ChainPlan,
  type ChainStopPlan,
  type CargoItem,
  type ChainFlow,
  type ChainFilteredStop,
} from './chain-types';

export function matWeightVolume(ticker: string, amount: number) {
  const mat = materialsStore.getByTicker(ticker);
  return {
    weight: mat ? mat.weight * amount : 0,
    volume: mat ? mat.volume * amount : 0,
  };
}

// started 订单日耗/日产补充：burn（calculatePlanetBurn）用 getRecurringOrders
// 过滤掉 started 订单，正在运行的产线（如 Animus a 的 PCB）input/output 会被遗漏，
// 导致其上下游在产业链中不被识别（Shardonia c 的 BCO/BGO → Animus a 的 PCB 边缺失）。
// 此处按与 burn 相同的归一化（每线 started 订单时长求和、×capacity）补充日消耗与日产。
function startedOrderSupplement(siteId: string): {
  input: Map<string, number>;
  output: Map<string, number>;
} {
  const input = new Map<string, number>();
  const output = new Map<string, number>();
  const lines = productionStore.getBySiteId(siteId);
  if (!lines) {
    return { input, output };
  }
  for (const line of lines) {
    const started = line.orders.filter(o => o.started && !o.halted && o.duration?.millis != null);
    if (started.length === 0) {
      continue;
    }
    const capacity = line.capacity;
    let totalMillis = 0;
    for (const order of started) {
      totalMillis += order.duration!.millis!;
    }
    const totalDays = totalMillis / 86400000;
    if (totalDays <= 0) {
      continue;
    }
    for (const order of started) {
      for (const mat of order.outputs) {
        const ticker = mat.material.ticker;
        output.set(ticker, (output.get(ticker) ?? 0) + (mat.amount * capacity) / totalDays);
      }
      for (const mat of order.inputs) {
        const ticker = mat.material.ticker;
        input.set(ticker, (input.get(ticker) ?? 0) + (mat.amount * capacity) / totalDays);
      }
    }
  }
  return { input, output };
}

// 预计到港时新增产出：按生产线订单起止时间精确推算（生产随时间线性累积）。
// 生产线模型：capacity = 并行槽位数，每订单占一个槽位、产出 outputs[].amount；
// 排队订单按序填满空闲槽位；循环（recurring）订单完成后副本在队尾重新入队
// （循环添加）——生产线到港前持续排产，连续多批（含未开始与循环批次）都能计入。
// 区间内完成比例 = (到港进度 − 当前进度)，进度 = (t − start) / (end − start) 钳制到 [0,1]；
// 已完成订单（end ≤ now）的产出已计入当前库存，不重复计算。
function projectedProductionByArrival(
  siteId: string,
  ticker: string,
  now: number,
  arrivalMs: number,
): number {
  const lines = productionStore.getBySiteId(siteId);
  if (!lines || arrivalMs <= now) {
    return 0;
  }
  let produced = 0;

  const countOrder = (outputs: PrunApi.MaterialAmountValue[], start: number, end: number) => {
    if (end <= now || start >= arrivalMs) {
      return;
    }
    const span = end - start;
    if (span <= 0) {
      return;
    }
    const progress = (t: number) => Math.min(Math.max((t - start) / span, 0), 1);
    const fraction = progress(arrivalMs) - progress(now);
    if (fraction <= 0) {
      return;
    }
    for (const out of outputs) {
      if (out.material.ticker === ticker) {
        produced += out.amount * fraction;
      }
    }
  };

  interface PendingOrder {
    duration: number;
    recurring: boolean;
    outputs: PrunApi.MaterialAmountValue[];
  }

  for (const line of lines) {
    const capacity = line.capacity;
    if (capacity <= 0) {
      continue;
    }
    // 槽位释放时刻（升序；空闲槽位数 = capacity − 长度）。
    const slotFree: number[] = [];
    // 等待队列（FIFO）：排队订单与循环订单完成后的副本。
    const queue: PendingOrder[] = [];
    // 未来时刻加入队列的循环副本：{ at, order }，按 at 升序。
    const joinAt: { at: number; order: PendingOrder }[] = [];
    const requeue = (order: PendingOrder, at: number) => {
      joinAt.push({ at, order });
      joinAt.sort((a, b) => a.at - b.at);
    };

    for (const order of line.orders) {
      if (order.duration?.millis == null || order.halted) {
        continue;
      }
      const pending: PendingOrder = {
        duration: order.duration.millis,
        recurring: order.recurring,
        outputs: order.outputs,
      };
      if (order.started) {
        // 已开始订单：占用槽位直到 completion（已完成的不占位）。
        const start = order.started.timestamp;
        const end = order.completion?.timestamp ?? start + order.duration.millis;
        if (end > now) {
          slotFree.push(end);
        }
        countOrder(order.outputs, start, end);
        if (order.recurring) {
          requeue(pending, end);
        }
      } else {
        queue.push(pending);
      }
    }

    // 事件模拟：按时间推进。有空槽则在当前时刻启动队首订单；
    // 无空槽则推进到最早槽位释放时刻；循环订单完成后副本在队尾重新排队。
    let t = now;
    while ((queue.length > 0 || joinAt.length > 0) && t < arrivalMs) {
      // 已到时刻的循环副本并入队尾。
      while (joinAt.length > 0 && joinAt[0].at <= t) {
        queue.push(joinAt.shift()!.order);
      }
      if (queue.length === 0) {
        // 队列空：跳到最早副本加入时刻（已由 while 条件保证 joinAt 非空）。
        const next = joinAt[0].at;
        if (next >= arrivalMs) {
          break;
        }
        t = next;
        continue;
      }
      if (slotFree.length < capacity) {
        // 有空槽：当前时刻启动队首订单。
        const pending = queue.shift()!;
        const start = t;
        const end = start + pending.duration;
        countOrder(pending.outputs, start, end);
        if (pending.recurring) {
          requeue(pending, end);
        }
        slotFree.push(end);
      } else {
        // 无空槽：推进到最早槽位释放时刻。
        const nextFree = Math.min(...slotFree);
        if (nextFree >= arrivalMs) {
          break;
        }
        slotFree.splice(slotFree.indexOf(nextFree), 1);
        t = nextFree;
      }
    }
  }
  return produced;
}

// 有效 burn：在 getPlanetBurn 基础上并入 started 订单的日耗/日产。
// burn 只记录「已出现在生产/劳动力」的 ticker，纯 started 产线的物料
// （如正在运行的 PCB 线的 BCO/BGO）不在 burn 中，其库存也从存储补读，
// 否则上游可提取量 / 下游缺口都会按 0 计。
export function effectiveBurn(siteId: string): BurnValues | undefined {
  const burn = getPlanetBurn(siteId);
  if (!burn) {
    return undefined;
  }
  const { input, output } = startedOrderSupplement(siteId);
  if (input.size === 0 && output.size === 0) {
    return burn.burn;
  }
  const stores = storagesStore.getByAddressableId(siteId);
  const merged: BurnValues = { ...burn.burn };
  const patch = (ticker: string, extra: number, key: 'input' | 'output') => {
    const existing = merged[ticker];
    if (existing !== undefined) {
      merged[ticker] = { ...existing, [key]: existing[key] + extra };
      return;
    }
    // 新建条目：真实库存从存储读取（burn 未记录该 ticker）。
    let inventory = 0;
    if (stores !== undefined) {
      for (const store of stores) {
        for (const item of store.items) {
          const q = item.quantity;
          if (q && q.material.ticker === ticker) {
            inventory += q.amount;
          }
        }
      }
    }
    merged[ticker] = {
      input: 0,
      output: 0,
      workforce: 0,
      dailyAmount: 0,
      remainingAllocation: 0,
      inventory,
      daysLeft: 0,
      type: key === 'output' ? 'output' : 'input',
    };
    merged[ticker]![key] = extra;
  };
  for (const [ticker, extra] of input) {
    patch(ticker, extra, 'input');
  }
  for (const [ticker, extra] of output) {
    patch(ticker, extra, 'output');
  }
  return merged;
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
 * 有实际卸货或提取操作的选中基地为环线站点；本轮无操作的基地会从 stops
 * 过滤，并通过 ChainPlan.filteredStops 保留 naturalId、星球名与过滤原因。
 * 无链关系但有补给或提取操作的基地仍按字母序混入航线，其产物视为最终产物运回出发地。
 * 数据未加载时返回 undefined。
 */
export function planChainRoute(input: {
  originNaturalId: string;
  capacity: ChainCapacity;
  bases: ChainPlannerBase[];
  // 出发地空间站仓库库存（ticker → 数量），用于以「取货」补足组内产出的缺口。
  originStock?: Record<string, number>;
  // 组内产出 ticker 集合（多船分段时传全局集合，跨段产物在任何段都不纳入采购）。
  groupProducedTickers?: Set<string>;
  // 出发地交易所代码（CX Buy 下单处），用于购买时检测空间站订单簿库存。
  exchangeCode?: string;
  purchaseStock?: Record<string, number>;
  // 各站预计到达时刻（相对规划时刻的小时数）：飞行期间基地继续生产/消耗，
  // 取货量按到达时预计库存计算，否则到港时取货包装不完飞行期间的新增产出。
  arrivalHoursByNaturalId?: Map<string, number>;
}): ChainPlan | undefined {
  const { originNaturalId, capacity, bases } = input;
  if (capacity.weight <= 0 && capacity.volume <= 0) {
    return undefined;
  }

  const warnings: string[] = [];

  // 各基地 burn 数据（任一未加载则整体视为加载中）。
  // 用有效 burn（合并 started 订单日耗/日产与真实库存），
  // 使正在运行的产线也参与产业链识别与运量平衡。
  const burns = new Map<string, BurnValues>();
  for (const base of bases) {
    const burn = effectiveBurn(base.siteId);
    if (!burn) {
      return undefined;
    }
    burns.set(base.naturalId, burn);
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
    // 有效 burn（含 started 订单日耗/日产）：burn 用 getRecurringOrders 过滤掉
    // started 订单，正在运行的产线（如 Animus a 的 PCB）input 不会出现在 burn.input，
    // 导致其上游不被识别为产业链节点（如 Shardonia c 的 BCO/BGO → Animus a 的 PCB）。
    const burn = effectiveBurn(site.siteId);
    if (!burn) {
      continue;
    }
    const naturalId = getEntityNaturalIdFromAddress(site.address);
    if (!naturalId) {
      continue;
    }
    for (const [ticker, mat] of Object.entries(burn)) {
      if (mat.input > 0 || mat.workforce > 0) {
        const list = consumers.get(ticker) ?? [];
        if (!list.includes(naturalId)) {
          list.push(naturalId);
        }
        consumers.set(ticker, list);
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
  // 产出部分按生产线订单起止时间精确推算（projectedProductionByArrival），
  // 消耗部分（劳动力+原料）按 burn 日均速率 × 飞行小时估算。
  // 未提供到达时刻（无飞行预估）时退化为当前库存，保持旧行为。
  const arrivalHoursOf = (id: string) => input.arrivalHoursByNaturalId?.get(id) ?? 0;
  const projectedInventory = (mat: MaterialBurn | undefined, ticker: string, id: string) => {
    if (mat === undefined) {
      return 0;
    }
    const hours = arrivalHoursOf(id);
    if (hours <= 0) {
      return mat.inventory;
    }
    const base = byNaturalId.get(id);
    if (!base) {
      return mat.inventory;
    }
    const now = gameNow();
    const arrivalMs = now + hours * 3600000;
    const produced = projectedProductionByArrival(base.siteId, ticker, now, arrivalMs);
    return mat.inventory + produced - (mat.input + mat.workforce) * (hours / 24);
  };

  // 目标天数（所有选中基地，含无链关系基地的采购补给）。
  const targetDays = new Map<string, number>();
  for (const base of bases) {
    targetDays.set(base.naturalId, clampTargetDays(base));
  }
  // need: 下游 ticker 需求 = 目标天数 × 日耗（原料+消耗品）− 库存。
  const need = (id: string, ticker: string) => {
    const mat = burns.get(id)![ticker];
    // ticker 不在该基地 burn 中（极少见，例如生产订单刚启动 burn 尚未刷新）→ 按 0 计。
    if (mat === undefined) {
      return 0;
    }
    return Math.max(
      0,
      Math.ceil(targetDays.get(id)! * (mat.input + mat.workforce) - mat.inventory),
    );
  };
  // avail: 上游可提取 = 到达时预计库存 − 自用预留（目标天数 × 自身日耗）。
  const avail = (id: string, ticker: string) => {
    const mat = burns.get(id)![ticker];
    if (mat === undefined) {
      return 0;
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
      const analysis = base ? getBaseStorageAnalysis(base.site) : undefined;
      return analysis ? analysis.daysUntilFull : Infinity;
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

  // 组内产出的物资（BSN 白名单 + output>0）：封闭环内自产自销，
  // 一律不纳入 CX 采购清单，全部经基地「提取」流转（送下游/运回空间站）。
  // 多船分段时由调用方传入全局集合，跨段产物在各段同样剔除采购。
  const groupProducedTickers = input.groupProducedTickers ?? new Set(producers.keys());

  // 每站 CX 账单：与基地规划派遣一致的完整账单（补给+维修），
  // 减去链上「确定输送」的量；组内产出的 ticker 整体剔除（缺口不回落 CX 采购）。
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
  // 出发地「取货」明细：naturalId → ticker → 数量（装载后随行到站卸货）。
  const originPickupByStop = new Map<string, Record<string, number>>();
  // 组内产出的缺口（需求超出上游可提取量且空间站库存不足）按 ticker 汇总，用于警告。
  const producedGap = new Map<string, number>();
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
    // 组内产出的物资不纳入 CX 采购：缺口优先由空间站仓库库存以「取货」补足，剩余缺口警告。
    for (const ticker of Object.keys(bill)) {
      if (!groupProducedTickers.has(ticker)) {
        continue;
      }
      const gap = bill[ticker]!;
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
      if (groupProducedTickers.has(ticker)) {
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
    if (!byNaturalId.get(id)!.config.cxBuy) {
      continue;
    }
    for (const [ticker, amount] of Object.entries(bill)) {
      const supply =
        input.purchaseStock?.[ticker] ??
        (input.exchangeCode === undefined
          ? undefined
          : cxobStore.getByTicker(`${ticker}.${input.exchangeCode}`)?.supply);
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
          `「${ticker}」订单簿供应不足（可购 ${fixed0(buy)} / 需 ${fixed0(wanted)}），已缩减本站配送量。`,
        );
        if (pickup + buy > 0) {
          bill[ticker] = pickup + buy;
        } else {
          delete bill[ticker];
        }
      }
    }
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

  // 沿航线模拟舱容：到站先卸（含链输送），再提取（链输送 + 最终产物），
  // 超载按比例缩减提取量并同步削减下游到货。
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
      // 最终产物装尽到港时预计库存（含飞行期间新增产出）：不扣自用预留
      // （自用是该基地 burn 的事）。链上 flows 仍按 avail（扣自用）避免抽空基地断粮。
      const mat = burns.get(id)![ticker];
      const amount = Math.max(0, Math.floor(projectedInventory(mat, ticker, id)));
      if (amount > 0) {
        finalPickup.push({ ticker, amount, from: id, dest: ORIGIN_DEST });
      }
    }
    // 有前向下游边的产物：已按需补给下游（flows），剩余 avail 运回空间站。
    // 遍历「所有下游边」而非仅正向 flows——下游已充足（need=0）时流量为 0，
    // 但产物仍有可提取余量，应运回空间站；否则会卡在基地既不送下游也不运回。
    for (const ticker of [...new Set(edges.filter(f => f.from === id).map(f => f.ticker))]) {
      const sent = delivered.get(id)?.get(ticker) ?? 0;
      const surplus = Math.max(0, avail(id, ticker) - sent);
      if (surplus > 0) {
        finalPickup.push({ ticker, amount: surplus, from: id, dest: ORIGIN_DEST });
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
      warnings.push(
        `「${stop.planetName}」链上输送超出船舱剩余载量，按下游优先度逐条截断（次要下游留待下航次）。`,
      );
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

  // 汇总装船总账单（全部站）与 CX 采购账单（仅开启「购买」的站，
  // 扣除出发地「取货」补足的部分——取货不产生采购）。
  for (const stop of stops) {
    for (const [ticker, amount] of Object.entries(stop.unloadCx)) {
      if (amount > 0) {
        plan.cxBill[ticker] = (plan.cxBill[ticker] ?? 0) + amount;
        const pickup = Math.min(amount, originPickupByStop.get(stop.naturalId)?.[ticker] ?? 0);
        if (pickup > 0) {
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
  return plan;
}
