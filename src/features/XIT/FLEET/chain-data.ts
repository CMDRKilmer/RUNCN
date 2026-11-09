import { getPlanetBurn } from '@src/core/burn';
import type { BurnValues } from '@src/core/burn';
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
import { combinedBaseBill } from '@src/features/XIT/FLEET/utils';
import type { ChainPlannerBase, ChainCapacity } from './chain-types';
import type { ChainPlanningSnapshot, ChainPlanningBase } from './chain-plan-core';

export type ChainRouteInput = {
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
};

export function matWeightVolume(ticker: string, amount: number) {
  const mat = materialsStore.getByTicker(ticker);
  return {
    weight: mat ? mat.weight * amount : 0,
    volume: mat ? mat.volume * amount : 0,
  };
}

// burn 不含已启动订单；按生产线容量和订单总时长补足日耗/日产。
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

export function collectChainPlanningSnapshot(
  input: ChainRouteInput,
): ChainPlanningSnapshot | undefined {
  const now = gameNow();
  const bases: ChainPlanningBase[] = [];
  const tickers = new Set<string>(Object.keys(input.originStock ?? {}));
  for (const base of input.bases) {
    const current = effectiveBurn(base.siteId);
    if (current === undefined) {
      return undefined;
    }
    const burn = Object.fromEntries(
      Object.entries(current).map(([ticker, value]) => [ticker, { ...value }]),
    );
    const bill = { ...(combinedBaseBill(base.naturalId, base.config, base.site) ?? {}) };
    const products = [...(getBaseProducts(base.siteId) ?? [])];
    const hours = input.arrivalHoursByNaturalId?.get(base.naturalId) ?? 0;
    const projectedStock: Record<string, number> = {};
    for (const [ticker, mat] of Object.entries(burn)) {
      projectedStock[ticker] =
        hours <= 0
          ? mat.inventory
          : mat.inventory +
            projectedProductionByArrival(base.siteId, ticker, now, now + hours * 3600000) -
            ((mat.input + mat.workforce) * hours) / 24;
      tickers.add(ticker);
    }
    for (const ticker of [...Object.keys(bill), ...products]) {
      tickers.add(ticker);
    }
    const analysis = getBaseStorageAnalysis(base.site);
    bases.push({
      naturalId: base.naturalId,
      planetName: base.planetName,
      days: clampTargetDaysUtil(base.config.days, getSuppliesCap(base.site)),
      cxBuy: base.config.cxBuy,
      burn,
      bill,
      products,
      projectedStock,
      daysUntilFull: analysis?.daysUntilFull ?? Infinity,
    });
  }
  const consumers = new Map<string, string[]>();
  for (const site of sitesStore.all.value ?? []) {
    const burn = effectiveBurn(site.siteId);
    const id = getEntityNaturalIdFromAddress(site.address);
    if (burn === undefined || id === undefined) {
      continue;
    }
    for (const [ticker, mat] of Object.entries(burn)) {
      if (mat.input <= 0 && mat.workforce <= 0) {
        continue;
      }
      const ids = consumers.get(ticker) ?? [];
      if (!ids.includes(id)) {
        ids.push(id);
      }
      consumers.set(ticker, ids);
    }
  }
  const materials: ChainPlanningSnapshot['materials'] = {};
  const purchaseStock: Record<string, number> = {};
  for (const ticker of tickers) {
    const material = materialsStore.getByTicker(ticker);
    if (material !== undefined) {
      materials[ticker] = { weight: material.weight, volume: material.volume };
    }
    const supply =
      input.purchaseStock?.[ticker] ??
      (input.exchangeCode === undefined
        ? undefined
        : cxobStore.getByTicker(`${ticker}.${input.exchangeCode}`)?.supply);
    if (supply !== undefined) {
      purchaseStock[ticker] = supply;
    }
  }
  const orderedIds = input.bases.map(x => x.naturalId).sort(comparePlanets);
  const planetRanks: Record<string, number> = {};
  let rank = 0;
  for (let i = 0; i < orderedIds.length; i++) {
    if (i > 0 && comparePlanets(orderedIds[i - 1], orderedIds[i]) !== 0) {
      rank++;
    }
    planetRanks[orderedIds[i]] = rank;
  }
  return {
    originNaturalId: input.originNaturalId,
    capacity: { ...input.capacity },
    bases,
    consumers,
    materials,
    planetRanks,
    originStock: { ...input.originStock },
    purchaseStock,
    groupProducedTickers:
      input.groupProducedTickers === undefined ? undefined : new Set(input.groupProducedTickers),
  };
}
