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
import { cycleDelivery, MIN_LOOP_SUPPLY_DAYS } from './native-route-loop';
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
  // 循环按 BURN 净额配货，不扣现有库存或读取单趟补给设置。
  loop?: boolean;
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

// 预计到港时新增产出：按生产线订单起止时间精确推算。
// 产出只在整批订单完成时入库，所以只计「到港前已完成」的订单（end ≤ 到港时刻）；
// 到港时仍在生产的那一批按 0 计（按进度折算会把不存在的库存算进来）。
// 生产线模型：capacity = 并行槽位数，每订单占一个槽位、产出 outputs[].amount；
// 排队订单按序填满空闲槽位；循环（recurring）订单完成后副本在队尾重新入队
// （循环添加）——生产线到港前持续排产，连续多批（含未开始与循环批次）都能计入。
// 每个槽位按「释放时刻」参与事件排序，订单开始时刻 = max(槽位空闲, 订单就绪)：
// 循环副本必须等上一批真正结束（不能抢用其它槽位提前释放的时间）。
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

  const countOrder = (outputs: PrunApi.MaterialAmountValue[], end: number) => {
    // 已完成订单的产出已在库存里；到港时仍未完成的批次不出料。
    if (end <= now || end > arrivalMs) {
      return;
    }
    for (const out of outputs) {
      if (out.material.ticker === ticker) {
        produced += out.amount;
      }
    }
  };

  interface PendingOrder {
    duration: number;
    recurring: boolean;
    outputs: PrunApi.MaterialAmountValue[];
    // 可开始时刻：排队订单 = 现在；循环订单的下一份 = 本次结束时刻。
    // 只有槽位空闲且订单已就绪才能开产——否则多槽位线上不同时长的订单会让
    // 循环副本抢在上一批结束前开工（到港产量被高估）。
    readyAt: number;
    seq: number;
  }

  let seq = 0;
  for (const line of lines) {
    const capacity = line.capacity;
    if (capacity <= 0) {
      continue;
    }
    // 槽位可用时刻（升序；长度 = 运行中的订单数 + 当前空闲槽位）。
    const slots: number[] = [];
    // 待开产订单：未开始订单现在就绪，循环副本在上一批结束时就绪。
    const pending: PendingOrder[] = [];

    for (const order of line.orders) {
      if (order.duration?.millis == null || order.duration.millis <= 0 || order.halted) {
        continue;
      }
      const run: PendingOrder = {
        duration: order.duration.millis,
        recurring: order.recurring,
        outputs: order.outputs,
        readyAt: now,
        seq: seq++,
      };
      if (order.started) {
        // 已开始订单：占用槽位直到 completion（已完成的不占位）。
        const start = order.started.timestamp;
        const end = order.completion?.timestamp ?? start + order.duration.millis;
        if (end > now) {
          slots.push(end);
        }
        countOrder(order.outputs, end);
        if (order.recurring) {
          run.readyAt = end;
          pending.push(run);
        }
      } else {
        pending.push(run);
      }
    }
    // 空闲槽位立即可用。
    while (slots.length < capacity) {
      slots.push(now);
    }

    // 离散事件：每次取最早可用的槽位，与最早就绪的订单配对；开始时刻 =
    // max(槽位空闲, 订单就绪)。时间只前进，循环副本绝不提前开工。
    while (slots.length > 0 && pending.length > 0) {
      slots.sort((a, b) => a - b);
      pending.sort((a, b) => {
        if (a.readyAt !== b.readyAt) {
          return a.readyAt - b.readyAt;
        }
        return a.seq - b.seq;
      });
      const slot = slots.shift()!;
      if (slot >= arrivalMs) {
        break;
      }
      const next = pending.shift()!;
      const start = Math.max(slot, next.readyAt);
      if (start >= arrivalMs) {
        break;
      }
      const end = start + next.duration;
      countOrder(next.outputs, end);
      if (next.recurring) {
        pending.push({ ...next, readyAt: end, seq: seq++ });
      }
      slots.push(end);
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

// 循环账单按配货天数的净缺口，自给或净产的材料不送。
export function loopBurnBill(burn: BurnValues, days: number): Record<string, number> {
  const bill: Record<string, number> = {};
  for (const [ticker, mat] of Object.entries(burn)) {
    const amount = cycleDelivery(mat, days);
    if (amount > 0) {
      bill[ticker] = amount;
    }
  }
  return bill;
}

export function collectChainPlanningSnapshot(
  input: ChainRouteInput,
): ChainPlanningSnapshot | undefined {
  const now = gameNow();
  const burnForSite = input.loop ? (siteId: string) => getPlanetBurn(siteId)?.burn : effectiveBurn;
  const bases: ChainPlanningBase[] = [];
  const tickers = new Set<string>(Object.keys(input.originStock ?? {}));
  for (const base of input.bases) {
    const current = burnForSite(base.siteId);
    if (current === undefined) {
      return undefined;
    }
    const burn = Object.fromEntries(
      Object.entries(current).map(([ticker, value]) => [ticker, { ...value }]),
    );
    const days = input.loop
      ? MIN_LOOP_SUPPLY_DAYS
      : clampTargetDaysUtil(base.config.days, getSuppliesCap(base.site));
    const bill = input.loop
      ? loopBurnBill(burn, days)
      : { ...(combinedBaseBill(base.naturalId, base.config, base.site) ?? {}) };
    const products = [...(getBaseProducts(base.siteId) ?? [])];
    const hours = input.arrivalHoursByNaturalId?.get(base.naturalId) ?? 0;
    const projectedStock: Record<string, number> = {};
    for (const [ticker, mat] of Object.entries(burn)) {
      // 循环提取按 BURN 日产；到港预计库存用于单趟。
      if (!input.loop) {
        projectedStock[ticker] =
          hours <= 0
            ? mat.inventory
            : mat.inventory +
              projectedProductionByArrival(base.siteId, ticker, now, now + hours * 3600000) -
              ((mat.input + mat.workforce) * hours) / 24;
      }
      tickers.add(ticker);
    }
    for (const ticker of [...Object.keys(bill), ...products]) {
      tickers.add(ticker);
    }
    const analysis = getBaseStorageAnalysis(base.site);
    bases.push({
      naturalId: base.naturalId,
      planetName: base.planetName,
      days,
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
    const burn = burnForSite(site.siteId);
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
    loop: input.loop,
  };
}
