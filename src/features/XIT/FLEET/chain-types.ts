import type { DispatchBaseConfig } from './utils';

// 出发地标记（最终产物运回出发地 CX）。
export const ORIGIN_DEST = '__ORIGIN__';

export interface ChainPlannerBase {
  siteId: string;
  naturalId: string;
  planetName: string;
  site: PrunApi.Site;
  config: DispatchBaseConfig;
}

// 环线舱容（重量/体积）。
export interface ChainCapacity {
  weight: number;
  volume: number;
  freeWeight: number;
  freeVolume: number;
}

// 产业链输送：上游基地 → 下游基地（按 ticker）。
export interface ChainFlow {
  ticker: string;
  from: string;
  to: string;
  amount: number;
}

// 舱内一件货物：装船于某站，目的地为下游站点或出发地。
export interface CargoItem {
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
  // 环线基地的采购配置，关闭时从出发地仓库取货。
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

export interface ChainFilteredStop {
  naturalId: string;
  planetName: string;
  // 过滤原因（该站没有任何卸货或提取操作）。
  reason: string;
}

export interface ChainPlan {
  // 出发地站点 naturalId（如 AI1），用于归航触发器匹配。
  originNaturalId: string;
  stops: ChainStopPlan[];
  // 被过滤的无操作站点；保留给规划界面解释为何未出现在航线中。
  filteredStops?: ChainFilteredStop[];
  // 归航时在出发地卸下的最终产物。
  finalUnload: Record<string, number>;
  // 出发地装船总账单（所有站账单合并，含未开启「购买」的基地）。
  cxBill: Record<string, number>;
  // 出发地在 CX 实际下单的账单（仅开启「购买」的基地）。
  purchaseBill: Record<string, number>;
  // 出发地「取货」清单：组内产出的缺口由空间站仓库库存补足（不采购，装船随行）。
  originPickup: Record<string, number>;
  warnings: string[];
  hasUnmetChainDemand?: true;
  peakLoad: { weight: number; volume: number };
  freeCapacity: { weight: number; volume: number };
  // 飞船总舱容（不是剩余）。
  capacity: { weight: number; volume: number };
  // 出发时舱载（装船后、飞首站前）。
  loadOnDeparture: { weight: number; volume: number };
  // 归航前舱载（最后站离开后、卸最终产物前）。
  loadOnReturn: { weight: number; volume: number };
  overCapacity: boolean;
  // 运回空间站产物的标注：ticker → 原因（无下游 / 循环下游需补给 / 循环下游已充足）。
  finalUnloadNotes?: Record<string, string>;
}
