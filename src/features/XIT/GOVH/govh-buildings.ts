// XIT GOVH →「基建建造」标签页的固化数据与成本公式。
//
// 系数一次性查阅 oogcapitalmanagement.com/infrastructure-calc 后固化到本仓库，
// 运行时零外部请求（与 GOVH 主面板同一红线）：
//   · 行星项目（Planetary Administration Center / Chamber of Global Commerce /
//     Shipyard / Local Market）是**一次性建造**，材料固定；
//   · 基础设施建筑 14 类按等级递增，每级成本 = round(基准 × 1.15^(level-1))，
//     逐级累加；等级 1~10；
//   · 仓库（Warehouse）每级容量 +500，材料按 baseFactor 数组逐级递增，等级 1~20。
//
// 面板口径：建筑与仓库都按「从 0 级建到目标级」计算，不读玩家当前等级。

/** 仓库每级材料倍数（索引 = 起始等级，累加到目标等级前）。 */
const WAREHOUSE_FACTOR = [1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10];

/** 仓库每级容量（2026-06 改版后每升一级 +500）。 */
export const WAREHOUSE_CAPACITY_PER_LEVEL = 500;

export const WAREHOUSE_MAX_LEVEL = 20;
export const BUILDING_MAX_LEVEL = 10;

/** 仓库升级消耗的物料基准值。 */
export const WAREHOUSE_MATERIALS: Readonly<Record<string, number>> = {
  BBH: 24,
  BDE: 24,
  BSE: 12,
  MCG: 300,
  TRU: 20,
};

export interface FixedProject {
  id: string;
  name: string;
  /** 原生基建代码，用于和 POPI 面板对照 */
  code: string;
  materials: Readonly<Record<string, number>>;
}

/** 行星项目：一次性建造，材料固定。名称与代码对齐原生 PPS 窗口的翻译。 */
export const PLANETARY_PROJECTS: readonly FixedProject[] = [
  {
    id: 'planetaryAdmin',
    name: '行星监管中心',
    code: 'ADM',
    materials: { LBH: 16, LDE: 32, LSE: 25, BMF: 2, MCG: 750, RTA: 5, BWS: 10 },
  },
  {
    id: 'cogc',
    name: '全球商会',
    code: 'CoGC',
    materials: { LBH: 32, LDE: 16, LSE: 24, BMF: 1, LTA: 32, SP: 32, BWS: 16 },
  },
  {
    id: 'shipyard',
    name: '船厂',
    code: 'SHY',
    materials: { ABH: 32, ADE: 24, ASE: 24, ATA: 8, TRU: 24 },
  },
  {
    id: 'localMarket',
    name: '本地市场',
    code: 'LOCM',
    materials: { BDE: 8, BSE: 12, BTA: 8, LBH: 8, TRU: 10 },
  },
];

export interface ScalableBuilding {
  code: string;
  name: string;
  baseMaterials: Readonly<Record<string, number>>;
}

/** 基础设施建筑：每级按 1.15 递增。 */
// name 必须与 govh-model.ts 的 UPKEEP_BUILDINGS.name 完全一致 —— 那是从 POPI 窗口
// 解析出来的游戏原生中文名，两处不一致时页面显示的就不是玩家在游戏里看到的建筑名。
export const SCALABLE_BUILDINGS: readonly ScalableBuilding[] = [
  {
    code: 'SST',
    name: '安全站',
    baseMaterials: { BBH: 24, BDE: 24, BSE: 12, BTA: 6, MCG: 300, TRU: 10 },
  },
  {
    code: 'SDP',
    name: '安防无人机站',
    baseMaterials: { RBH: 16, RDE: 16, RSE: 10, RTA: 8, MCG: 300, TRU: 8, ADS: 1, DOU: 1, BMF: 1 },
  },
  {
    code: 'EMC',
    name: '应急中心',
    baseMaterials: { BTA: 16, LBH: 32, LDE: 32, LSE: 24, MCG: 300, DOU: 1, TCU: 1 },
  },
  {
    code: 'INF',
    name: '医务室',
    baseMaterials: { BBH: 24, BDE: 24, BSE: 16, BTA: 12, MCG: 300, TRU: 10 },
  },
  {
    code: 'HOS',
    name: '医院',
    baseMaterials: { RBH: 24, RDE: 20, RSE: 20, RTA: 16, MCG: 400, TRU: 16, SU: 1, DOU: 1, TCU: 1 },
  },
  {
    code: 'WCE',
    name: '健康中心',
    baseMaterials: { LBH: 36, LDE: 36, LSE: 32, LTA: 24, MCG: 500, TRU: 16, DEC: 40, FLO: 12 },
  },
  {
    code: 'PAR',
    name: '野生动物园',
    baseMaterials: { BBH: 16, BDE: 16, BSE: 20, BTA: 10, MCG: 300, HAB: 5, SOI: 100 },
  },
  {
    code: '4DA',
    name: '4D游乐中心',
    baseMaterials: {
      LBH: 42,
      LDE: 42,
      LSE: 42,
      LTA: 24,
      MCG: 600,
      TRU: 40,
      ADS: 1,
      BMF: 2,
      FUN: 10,
      LIT: 2,
    },
  },
  {
    code: 'ACA',
    name: '艺术餐厅',
    baseMaterials: { RBH: 16, RDE: 24, RSE: 24, RTA: 12, MCG: 300, TRU: 20, DEC: 32 },
  },
  {
    code: 'ART',
    name: '画廊',
    baseMaterials: { LBH: 24, LDE: 32, LSE: 32, LTA: 16, MCG: 300, TRU: 20, DEC: 10, WOR: 2 },
  },
  {
    code: 'VRT',
    name: 'VR剧院',
    baseMaterials: { RBH: 24, RDE: 32, RSE: 32, RTA: 12, MCG: 500, TRU: 30, ADS: 1, DEC: 20 },
  },
  {
    code: 'PBH',
    name: '行星广播站',
    baseMaterials: { RBH: 16, RDE: 24, RSE: 24, RTA: 12, MCG: 300, TRU: 30, ADS: 1, COM: 1 },
  },
  {
    code: 'LIB',
    name: '图书馆',
    baseMaterials: { ABH: 8, ADE: 12, ASE: 12, ATA: 6, MCG: 250, TRU: 20, COM: 1, LOG: 1 },
  },
  {
    code: 'UNI',
    name: '大学',
    baseMaterials: { ABH: 12, ADE: 16, ASE: 16, ATA: 12, MCG: 400, TRU: 30, BMF: 2, LU: 4, LOG: 1 },
  },
];

/** 单级成本：round(基准 × 1.15^(level-1))，从 from+1 级累加到 to 级。 */
export function levelCost(base: number, from: number, to: number): number {
  let total = 0;
  for (let level = from + 1; level <= to; level++) {
    total += Math.round(base * Math.pow(1.15, level - 1));
  }
  return total;
}

/** 仓库从 from 级升到 to 级的材料倍数。 */
export function warehouseFactor(from: number, to: number): number {
  let factor = 0;
  for (let level = from; level < to; level++) {
    factor += WAREHOUSE_FACTOR[level] ?? 0;
  }
  return factor;
}

export interface BuildSelection {
  /** 勾选的行星项目 id */
  projects: readonly string[];
  /** 建筑代码 → 目标等级 */
  levels: Readonly<Record<string, number>>;
  /** 建筑代码 → 起始等级（默认 0；读政府当前等级时从 snapshot.levels 带入） */
  startLevels?: Readonly<Record<string, number>>;
  /** 仓库目标等级 */
  warehouseLevel: number;
  /** 仓库起始等级（默认 0） */
  startWarehouseLevel?: number;
}

/** 汇总一次建造的全部物料需求（不做任何库存抵扣）。 */
export function computeBuildMaterials(selection: BuildSelection): Record<string, number> {
  const totals: Record<string, number> = {};
  const add = (ticker: string, amount: number) => {
    if (amount > 0) {
      totals[ticker] = (totals[ticker] ?? 0) + amount;
    }
  };

  for (const project of PLANETARY_PROJECTS) {
    if (!selection.projects.includes(project.id)) {
      continue;
    }
    for (const [ticker, amount] of Object.entries(project.materials)) {
      add(ticker, amount);
    }
  }

  for (const building of SCALABLE_BUILDINGS) {
    const target = Math.min(selection.levels[building.code] ?? 0, BUILDING_MAX_LEVEL);
    const from = Math.min(selection.startLevels?.[building.code] ?? 0, target);
    if (target <= 0 || target <= from) {
      continue;
    }
    for (const [ticker, base] of Object.entries(building.baseMaterials)) {
      add(ticker, levelCost(base, from, target));
    }
  }

  const warehouseUpTo = Math.min(selection.warehouseLevel, WAREHOUSE_MAX_LEVEL);
  const warehouseFrom = Math.min(selection.startWarehouseLevel ?? 0, warehouseUpTo);
  if (warehouseUpTo > warehouseFrom) {
    const factor = warehouseFactor(warehouseFrom, warehouseUpTo);
    for (const [ticker, base] of Object.entries(WAREHOUSE_MATERIALS)) {
      add(ticker, base * factor);
    }
  }

  return totals;
}
