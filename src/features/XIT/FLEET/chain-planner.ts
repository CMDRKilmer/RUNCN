import { getPlanetBurn } from '@src/core/burn';
import type { BurnValues } from '@src/core/burn';
import { getBaseStorageAnalysis } from '@src/core/storage-analysis';
import { comparePlanets } from '@src/util';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { createId } from '@src/store/create-id';
import {
  computeResupplyBill,
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
  // 卸货（船→基地）：CX 采购的非链物资。
  unloadCx: Record<string, number>;
  // 卸货（船→基地）：上游基地输送来的链上物资。ticker → { 数量, 来源星球名 }。
  unloadChain: Map<string, { amount: number; from: string }>;
  // 提取（基地→船）：本站产物。ticker → { 数量, 去向标签 }。
  load: Map<string, { amount: number; to: string }>;
  // 提取被舱容缩减过。
  clipped: boolean;
  // 链上缺口：上游库存不足，下游需求无法满足的部分。
  deficits: Map<string, number>;
}

export interface ChainPlan {
  // 出发地站点 naturalId（如 AI1），用于归航触发器匹配。
  originNaturalId: string;
  stops: ChainStopPlan[];
  // 归航时在出发地卸下的最终产物。
  finalUnload: Record<string, number>;
  // 出发地在 CX 采购的总账单（所有站的非链物资合并）。
  cxBill: Record<string, number>;
  warnings: string[];
  peakLoad: { weight: number; volume: number };
  freeCapacity: { weight: number; volume: number };
  overCapacity: boolean;
}

function matWeightVolume(ticker: string, amount: number) {
  const mat = materialsStore.getByTicker(ticker);
  return {
    weight: mat ? mat.weight * amount : 0,
    volume: mat ? mat.volume * amount : 0,
  };
}

// 目标天数：与 computeResupplyBill 相同的 suppliesCapDays 钳制。
function clampTargetDays(base: ChainPlannerBase) {
  const capDays = getBaseStorageAnalysis(base.site)?.suppliesCapDays;
  const cap = capDays === undefined || !isFinite(capDays) ? Infinity : capDays;
  return Math.max(0, Math.min(base.config.days, cap));
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

  // 推断产业链边：A 产出 T 且 B 消耗 T（原料或劳动力消耗品）→ A→B。
  const producers = new Map<string, string[]>();
  const consumers = new Map<string, string[]>();
  for (const [naturalId, burn] of burns) {
    for (const [ticker, mat] of Object.entries(burn)) {
      if (mat.output > 0) {
        const list = producers.get(ticker) ?? [];
        list.push(naturalId);
        producers.set(ticker, list);
      }
      if (mat.input > 0 || mat.workforce > 0) {
        const list = consumers.get(ticker) ?? [];
        list.push(naturalId);
        consumers.set(ticker, list);
      }
    }
  }

  const rawEdges: ChainFlow[] = [];
  for (const [ticker, producerIds] of producers) {
    const consumerIds = consumers.get(ticker) ?? [];
    for (const from of producerIds) {
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
    warnings,
    peakLoad: { weight: 0, volume: 0 },
    freeCapacity: {
      weight: ship.cargoStore.weightCapacity - ship.cargoStore.weightLoad,
      volume: ship.cargoStore.volumeCapacity - ship.cargoStore.volumeLoad,
    },
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
  const flows: ChainFlow[] = [];
  const deficits = new Map<string, number>(); // `${to}|${ticker}` → 缺口
  for (const ticker of new Set(edges.map(x => x.ticker))) {
    const tickerEdges = edges.filter(x => x.ticker === ticker);
    const upstreams = [...new Set(tickerEdges.map(x => x.from))];
    const downstreams = [...new Set(tickerEdges.map(x => x.to))];
    const needs = new Map(downstreams.map(x => [x, need(x, ticker)] as const));
    const totalNeed = [...needs.values()].reduce((a, b) => a + b, 0);
    if (totalNeed <= 0) {
      continue;
    }
    const avails = new Map(upstreams.map(x => [x, avail(x, ticker)] as const));
    const totalAvail = [...avails.values()].reduce((a, b) => a + b, 0);
    for (const to of downstreams) {
      const needTo = needs.get(to)!;
      if (needTo <= 0) {
        continue;
      }
      if (totalAvail <= 0) {
        deficits.set(`${to}|${ticker}`, needTo);
        continue;
      }
      const share = Math.min(needTo, (totalAvail * needTo) / totalNeed);
      if (share < needTo) {
        deficits.set(`${to}|${ticker}`, Math.ceil(needTo - share));
      }
      for (const from of upstreams) {
        const amount = Math.floor((avails.get(from)! * share) / totalAvail);
        if (amount > 0) {
          flows.push({ ticker, from, to, amount });
        }
      }
    }
  }

  // 每站非链物资的 CX 账单（剔除链上 ticker，避免重复补给）。
  const chainTickersByStop = new Map<string, Set<string>>();
  for (const flow of flows) {
    const set = chainTickersByStop.get(flow.to) ?? new Set<string>();
    set.add(flow.ticker);
    chainTickersByStop.set(flow.to, set);
  }
  const cxResupply = new Map<string, Record<string, number>>();
  for (const id of order) {
    const base = byNaturalId.get(id)!;
    if (!base.config.resupply) {
      cxResupply.set(id, {});
      continue;
    }
    const bill = computeResupplyBill(
      {
        useBaseInv: true,
        consumablesOnly: base.config.consumablesOnly,
        includeConsumables: base.config.includeConsumables,
        exclusions: chainTickersByStop.get(id),
      },
      id,
      targetDays.get(id),
    );
    cxResupply.set(id, bill ?? {});
  }

  // 最终产物：产出且无任何下游边的 ticker → 全部提取回出发地
  // （无链关系基地的全部产物均属最终产物）。
  const consumerTickers = new Set(edges.map(x => x.ticker));
  const finalTickers = new Map<string, string[]>(); // naturalId → tickers
  for (const id of order) {
    const burn = burns.get(id)!;
    const list: string[] = [];
    for (const [ticker, mat] of Object.entries(burn)) {
      if (mat.output > 0 && !consumerTickers.has(ticker)) {
        list.push(ticker);
      }
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

  const stops: ChainStopPlan[] = [];
  for (const id of order) {
    const base = byNaturalId.get(id)!;
    const stop: ChainStopPlan = {
      naturalId: id,
      planetName: base.planetName || id,
      days: targetDays.get(id)!,
      unloadCx: {},
      unloadChain: new Map(),
      load: new Map(),
      clipped: false,
      deficits: new Map(),
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

    // 链缺口（本站下游需求未被上游满足的部分）。
    for (const [key, deficit] of deficits) {
      const [to, ticker] = key.split('|');
      if (to === id && deficit > 0) {
        stop.deficits.set(ticker, deficit);
      }
    }

    // 提取：本站产物送往下游各站 + 最终产物回出发地。
    const pickup: CargoItem[] = [];
    for (const flow of flows) {
      if (flow.from === id && flow.amount > 0) {
        pickup.push({ ticker: flow.ticker, amount: flow.amount, from: id, dest: flow.to });
      }
    }
    for (const ticker of finalTickers.get(id) ?? []) {
      const amount = avail(id, ticker);
      if (amount > 0) {
        pickup.push({ ticker, amount, from: id, dest: ORIGIN_DEST });
      }
    }
    const clipped = pushItems(pickup);
    stop.clipped = clipped;
    if (clipped) {
      warnings.push(`「${stop.planetName}」提取超出船舱剩余载量，已按比例缩减。`);
    }
    for (const item of pickup) {
      if (item.amount <= 0) {
        continue;
      }
      const to =
        item.dest === ORIGIN_DEST
          ? '回出发地'
          : byNaturalId.get(item.dest)?.planetName || item.dest;
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

    trackPeak();
    stops.push(stop);
  }

  // 归航：卸下最终产物。
  for (const item of cargo) {
    if (item.dest === ORIGIN_DEST && item.amount > 0) {
      plan.finalUnload[item.ticker] = (plan.finalUnload[item.ticker] ?? 0) + item.amount;
    }
  }

  // 汇总 CX 总账单。
  for (const bill of cxResupply.values()) {
    for (const [ticker, amount] of Object.entries(bill)) {
      if (amount > 0) {
        plan.cxBill[ticker] = (plan.cxBill[ticker] ?? 0) + amount;
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
 * - 主包：加油 + CX 采购非链物资 + 装船 + 飞往第一站；
 * - 每站包：卸货（船→基地）+ 提取（基地→船）+ 飞往下一站（末站飞回出发地）；
 * - 归航包：最终产物卸至出发地仓库。
 * 卸货/提取 MTRA 始终成对存在（即使某侧为空），保证 OPEN SFC 能从「提取」
 * 动作解析出飞船。空的 MTRA 组会立即完成，无副作用。
 */
export function buildChainActionPackages(
  ship: DispatchShip,
  plan: ChainPlan,
  options: { refuel: boolean },
): ChainActionPlan | undefined {
  if (!ship.warehouseStore || !ship.cargoStore) {
    return undefined;
  }
  const shipName = ship.ship.name ?? ship.ship.registration;
  const loadGroupName = `装载 ${shipName}`;
  const originWarehouse = serializeStorage(ship.warehouseStore);
  const shipCargo = serializeStorage(ship.cargoStore);

  const actions: UserData.ActionData[] = [];
  const groups: UserData.MaterialGroupData[] = [
    { type: 'Manual', name: loadGroupName, materials: plan.cxBill },
  ];

  if (options.refuel) {
    actions.push({
      type: 'Refuel',
      name: '加油',
      origin: originWarehouse,
      buyMissingFuel: true,
    });
  }

  if (Object.keys(plan.cxBill).length > 0) {
    const buyGroupName = `购买 ${ship.exchangeCode}`;
    groups.push({ type: 'Manual', name: buyGroupName, materials: plan.cxBill });
    actions.push({
      type: 'CX Buy',
      name: buyGroupName,
      group: buyGroupName,
      exchange: ship.exchangeCode,
      useCXInv: true,
    });
  }

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
  }

  const mainPkg: UserData.ActionPackageData = {
    global: { name: `环线派遣 ${shipName}` },
    groups,
    actions,
  };

  const makeTrigger = (name: string, pkgName: string, planet: string): UserData.TriggerData => ({
    id: createId(),
    name,
    enabled: true,
    event: { type: 'FLIGHT_ENDED', ship: ship.ship.registration, planet },
    packageName: pkgName,
    mode: 'CONFIRM',
    cooldownMin: 60,
    createdAt: Date.now(),
    autoDelete: true,
  });

  const stopPkgs: ChainStopPackage[] = [];
  for (let i = 0; i < plan.stops.length; i++) {
    const stop = plan.stops[i]!;
    const pkgName = `${stop.planetName} 环线 ${shipName}`;
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
      ],
    };
    stopPkgs.push({
      pkg,
      trigger: makeTrigger(`${stop.planetName} 环线站`, pkgName, stop.naturalId),
    });
  }

  let finalPkg: ChainStopPackage | undefined;
  if (Object.keys(plan.finalUnload).length > 0) {
    const pkgName = `环线归航 ${shipName}`;
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
