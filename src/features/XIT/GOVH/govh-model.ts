// XIT GOVH 政府基建补给助手 — 固化系数与纯计算模型。
//
// 数据来源（仅开发期一次性查阅，运行时零网络）：
//   - 需求分层 / 封顶 / 幸福度：https://pct.fnar.net/population-infrastructure/
//   - 基建表 UPKEEP_BUILDINGS / 权重 HAPPINESS_WEIGHTS：oogcapitalmanagement.com/infra-data.js
//   - 求解算法 computeCheapestFulfillment：oogcapitalmanagement.com/governor-calc.js
//   - 计算示例：https://oogcapitalmanagement.com/governor-helper/?planet=EUU
// 抓取日期 2026-11-10，与 docs/game/governor-helper-plan.md 同步维护。
//
// 本文件只放纯数据与纯函数：不 import Vue / DOM / FIO / 游戏 store。
// 运行时输入全部由 govh-dom.ts（POPR / POPI / POPID DOM）与调用方
// （sitesStore 基地数、cxobStore 价格）从游戏本地补入。绝不回退外部价格源。
//
// 核心机制（与 oog 官方一致）：
//   - 每种物料独立提供其建筑需求贡献的 1/n（n=该建筑物料数）；
//   - fulfillment = provided / needed；满足度按 4 层封顶；
//   - 维生由住房 / 星球肥沃度决定，政府补给改变不了它；求解时按
//     lifeSupportAssumption 选封顶基线（当前 POPR 现值 / 住房补齐后 100%），
//     同一基线同时用于 Phase1 缺口、Phase2 达标判据与预览，避免口径分裂；
//   - 已填满的设施存量（POPID 两格都满）自动计入，再逐需求按「当前短板需求的
//     每 credit 贡献」贪心选待采购物料，最后剔除冗余避免超买。
//     这是启发式近似，不是严格全局最优（见文档「求解流程」）。

// ── 六类需求 & 分层 ────────────────────────────────────────────────────
export const NEEDS = [
  'LIFE_SUPPORT',
  'SAFETY',
  'HEALTH',
  'COMFORT',
  'CULTURE',
  'EDUCATION',
] as const;
export type Need = (typeof NEEDS)[number];

// 参与基建求解的需求（维生不参与：肥沃恒 100%，非肥沃靠住房）。
export const INFRA_NEEDS = ['SAFETY', 'HEALTH', 'COMFORT', 'CULTURE', 'EDUCATION'] as const;
export type InfraNeed = (typeof INFRA_NEEDS)[number];

// 维生预期：政府管理者改不了维生，只能选择按哪个假设安排基建备货。
//   current = 按 POPR 当前维生满足度封顶，有效目标压到 min(1, 维生现值)；
//   full    = 假定一个人口报告周期内住房补齐到 100%，按 100% 全额备货。
// 纯函数缺省 current 保持向后兼容；运行时默认值由 GOVH.vue 的 useTileState 决定。
// 目标满足度恒为 100%（「省钱档 / 70%」旋钮已从模型与界面移除，求解器不再接受任意 target）。
export type LifeSupportAssumption = 'current' | 'full';

// 补满范围：
//   next = 只补「下一次消耗」那一格（即时仓）——够撑到下一次结算，最省料；
//   both = 即时仓 + 储备仓（30 天缓冲）——一次填满，之后只在消耗时补。
// 两格的满格容量都来自本地容量表（见 FACILITY_CAPACITY）。
export type FillScope = 'next' | 'both';

export const NEED_LABELS: Record<Need, string> = {
  LIFE_SUPPORT: '维生',
  SAFETY: '安全',
  HEALTH: '健康',
  COMFORT: '舒适',
  CULTURE: '文化',
  EDUCATION: '教育',
};

// 4 层封顶：高层不能超过其下一层最差的一项。
export const TIERS: readonly (readonly Need[])[] = [
  ['LIFE_SUPPORT'],
  ['SAFETY', 'HEALTH'],
  ['COMFORT', 'CULTURE'],
  ['EDUCATION'],
];

// ── 五类人口 ────────────────────────────────────────────────────────────
export const LEVELS = ['PIONEER', 'SETTLER', 'TECHNICIAN', 'ENGINEER', 'SCIENTIST'] as const;
export type WorkforceLevel = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<WorkforceLevel, string> = {
  PIONEER: '先驱者',
  SETTLER: '定居者',
  TECHNICIAN: '职技工',
  ENGINEER: '工程师',
  SCIENTIST: '科学家',
};

// 六类需求权重（每类人口对 6 项需求的权重，行和 = 1）。
export const HAPPINESS_WEIGHTS: Record<WorkforceLevel, Record<Need, number>> = {
  PIONEER: {
    LIFE_SUPPORT: 0.54,
    SAFETY: 0.25,
    HEALTH: 0.15,
    COMFORT: 0.03,
    CULTURE: 0.02,
    EDUCATION: 0.01,
  },
  SETTLER: {
    LIFE_SUPPORT: 0.41,
    SAFETY: 0.3,
    HEALTH: 0.2,
    COMFORT: 0.03,
    CULTURE: 0.03,
    EDUCATION: 0.03,
  },
  TECHNICIAN: {
    LIFE_SUPPORT: 0.15,
    SAFETY: 0.2,
    HEALTH: 0.3,
    COMFORT: 0.2,
    CULTURE: 0.1,
    EDUCATION: 0.05,
  },
  ENGINEER: {
    LIFE_SUPPORT: 0.1,
    SAFETY: 0.1,
    HEALTH: 0.15,
    COMFORT: 0.35,
    CULTURE: 0.2,
    EDUCATION: 0.1,
  },
  SCIENTIST: {
    LIFE_SUPPORT: 0.05,
    SAFETY: 0.1,
    HEALTH: 0.1,
    COMFORT: 0.2,
    CULTURE: 0.25,
    EDUCATION: 0.3,
  },
};

// 游戏显示的幸福度 = 最近 5 周加权平均（v1 展示游戏给定值，此表供参考）。
export const HAPPINESS_WEEK_WEIGHTS = [0.4, 0.25, 0.2, 0.1, 0.05] as const;

// ── 14 座基建建筑（实机 POPI 列表，顺序与游戏 / oog infra-data.js 一致）──
// materials 是这座建筑维护要用的物料清单（不含任何消耗速率）；
// needs 是全部物料供给时每 1 级提供的需求单位。
// 本插件不涉及「日耗」：备货是一次性填满两格仓，容量直接查
// FACILITY_CAPACITY 或读 POPID 的 progress.max，不需要消耗速率参与。
export interface UpkeepBuilding {
  ticker: string;
  name: string;
  enName: string;
  materials: readonly string[];
  needs: Partial<Record<InfraNeed, number>>;
}

export const UPKEEP_BUILDINGS: readonly UpkeepBuilding[] = [
  {
    ticker: 'SST',
    name: '安全站',
    enName: 'Safety Station',
    materials: ['DW', 'OFF', 'SUN'],
    needs: { SAFETY: 2500 },
  },
  {
    ticker: 'SDP',
    name: '安防无人机站',
    enName: 'Security Drone Post',
    materials: ['POW', 'RAD', 'CCD', 'SUD'],
    needs: { SAFETY: 5000 },
  },
  {
    ticker: 'EMC',
    name: '应急中心',
    enName: 'Emergency Center',
    materials: ['PK', 'POW', 'BND', 'RED', 'BSC'],
    needs: { SAFETY: 1000, HEALTH: 1000 },
  },
  {
    ticker: 'INF',
    name: '医务室',
    enName: 'Infirmary',
    materials: ['OFF', 'TUB', 'STR'],
    needs: { HEALTH: 2500 },
  },
  {
    ticker: 'HOS',
    name: '医院',
    enName: 'Hospital',
    materials: ['PK', 'SEQ', 'BND', 'SDR', 'RED', 'BSC'],
    needs: { HEALTH: 5000 },
  },
  {
    ticker: 'WCE',
    name: '健康中心',
    enName: 'Wellness Center',
    materials: ['KOM', 'OLF', 'DW', 'DEC', 'PFE', 'SOI'],
    needs: { HEALTH: 1000, COMFORT: 1000 },
  },
  {
    ticker: 'PAR',
    name: '野生动物园',
    enName: 'Park',
    materials: ['DW', 'FOD', 'PFE', 'SOI', 'DEC'],
    needs: { COMFORT: 2500 },
  },
  {
    ticker: '4DA',
    name: '4D游乐中心',
    enName: '4D Arcades',
    materials: ['POW', 'MHP', 'OLF', 'BID', 'HOG', 'EDC'],
    needs: { COMFORT: 5000 },
  },
  {
    ticker: 'ACA',
    name: '艺术餐厅',
    enName: 'Art Cafe',
    materials: ['COF', 'OLF', 'VIT', 'DW', 'GL', 'DEC'],
    needs: { COMFORT: 1000, CULTURE: 1000 },
  },
  {
    ticker: 'ART',
    name: '画廊',
    enName: 'Art Gallery',
    materials: ['MHP', 'HOG', 'UTS', 'DEC'],
    needs: { CULTURE: 2500 },
  },
  {
    ticker: 'VRT',
    name: 'VR剧院',
    enName: 'VR Theater',
    materials: ['POW', 'MHP', 'HOG', 'OLF', 'BID', 'DEC'],
    needs: { CULTURE: 5000 },
  },
  {
    ticker: 'PBH',
    name: '行星广播站',
    enName: 'Planetary Broadcasting Hub',
    materials: ['OFF', 'MHP', 'SP', 'AAR', 'EDC', 'IDC'],
    needs: { CULTURE: 1000, EDUCATION: 1000 },
  },
  {
    ticker: 'LIB',
    name: '图书馆',
    enName: 'Library',
    materials: ['MHP', 'HOG', 'CD', 'DIS', 'BID'],
    needs: { EDUCATION: 2500 },
  },
  {
    ticker: 'UNI',
    name: '大学',
    enName: 'University',
    materials: ['COF', 'REA', 'TUB', 'BID', 'HD', 'IDC'],
    needs: { EDUCATION: 5000 },
  },
];

// 全部可补给物料（去重、按 ticker 排序）。
export const ALL_MATERIALS: readonly string[] = [
  ...new Set(UPKEEP_BUILDINGS.flatMap(b => b.materials)),
].sort();

const BUILDING_BY_TICKER = new Map(UPKEEP_BUILDINGS.map(b => [b.ticker, b]));
export function getBuilding(ticker: string): UpkeepBuilding | undefined {
  return BUILDING_BY_TICKER.get(ticker);
}

// ── 每级容量表（满仓量离线推算）─────────────────────────────────────────
// 2026-11-13 只读实测 VH-192b / AW-844a / QQ-001a 三颗星球、71 组
// 「建筑 × 物料 × 建成等级 × 运行等级」，下面两条公式 71/71 全命中：
//   储备满格       = reserve × 建成等级
//   下一次消耗满格 = next    × 运行等级（LR「人口」标签的「当前」列）
// 两格用的不是同一个等级：QQ-001a 的 SST 建成 10 / 运行 7，
// 储备 3000 = 300 × 10，下一次消耗 350 = 50 × 7（不是 10 级应有的 500）；
// INF 建成 9 / 运行 5 同理。等级上限 10 级，全程线性。
//
// 表里直接存**整数每级容量**（等级只是乘数），不存任何消耗速率再去乘：
// 速率是四舍五入值，乘出来会偏（实测 1800，按速率自算得 1801）。
//
// 覆盖范围：实测过的 11 类建筑 54 条（4DA / VRT 于 2026-11-13 在 OT-889b 补测）。
// EMC / HOS / WCE 还没有样本（周期是「建筑 × 物料」属性，同一物料在不同建筑可以
// 不同——BID 在 LIB 是 15 天、在 UNI 是 5 天——所以不能跨建筑外推），
// 这几类继续用 POPID 实测值。
export interface MaterialCapacity {
  // 储备每级容量（30 天用量）。
  reserve: number;
  // 「下一次消耗」每级容量（一个消耗周期：5 天或 15 天）。
  next: number;
}

export const FACILITY_CAPACITY: Readonly<
  Record<string, Readonly<Record<string, MaterialCapacity>>>
> = {
  SST: {
    DW: { reserve: 300, next: 50 },
    OFF: { reserve: 300, next: 50 },
    SUN: { reserve: 60, next: 30 },
  },
  SDP: {
    POW: { reserve: 30, next: 5 },
    RAD: { reserve: 14, next: 7 },
    CCD: { reserve: 2, next: 1 },
    SUD: { reserve: 2, next: 1 },
  },
  INF: {
    OFF: { reserve: 300, next: 50 },
    TUB: { reserve: 200, next: 100 },
    STR: { reserve: 20, next: 10 },
  },
  PAR: {
    DW: { reserve: 300, next: 50 },
    FOD: { reserve: 180, next: 30 },
    PFE: { reserve: 60, next: 10 },
    SOI: { reserve: 100, next: 50 },
    DEC: { reserve: 10, next: 5 },
  },
  '4DA': {
    POW: { reserve: 60, next: 10 },
    MHP: { reserve: 60, next: 10 },
    OLF: { reserve: 120, next: 20 },
    BID: { reserve: 6, next: 3 },
    HOG: { reserve: 6, next: 3 },
    EDC: { reserve: 6, next: 3 },
  },
  ACA: {
    DW: { reserve: 300, next: 50 },
    COF: { reserve: 240, next: 40 },
    VIT: { reserve: 240, next: 40 },
    OLF: { reserve: 60, next: 10 },
    GL: { reserve: 200, next: 100 },
    DEC: { reserve: 20, next: 10 },
  },
  ART: {
    MHP: { reserve: 30, next: 5 },
    HOG: { reserve: 30, next: 5 },
    UTS: { reserve: 20, next: 10 },
    DEC: { reserve: 20, next: 10 },
  },
  VRT: {
    POW: { reserve: 42, next: 7 },
    MHP: { reserve: 60, next: 10 },
    HOG: { reserve: 42, next: 7 },
    OLF: { reserve: 120, next: 20 },
    BID: { reserve: 10, next: 5 },
    DEC: { reserve: 20, next: 10 },
  },
  PBH: {
    OFF: { reserve: 300, next: 50 },
    MHP: { reserve: 30, next: 5 },
    SP: { reserve: 40, next: 20 },
    AAR: { reserve: 20, next: 10 },
    EDC: { reserve: 8, next: 4 },
    IDC: { reserve: 4, next: 2 },
  },
  LIB: {
    MHP: { reserve: 30, next: 5 },
    HOG: { reserve: 30, next: 5 },
    CD: { reserve: 10, next: 5 },
    DIS: { reserve: 10, next: 5 },
    BID: { reserve: 6, next: 3 },
  },
  UNI: {
    COF: { reserve: 300, next: 50 },
    REA: { reserve: 300, next: 50 },
    TUB: { reserve: 300, next: 50 },
    HD: { reserve: 20, next: 10 },
    BID: { reserve: 10, next: 5 },
    IDC: { reserve: 6, next: 3 },
  },
};

// 某建筑某物料在给定建成 / 运行等级下的满仓两格容量；表外组合返回 undefined
// （调用方回退 POPID 实测值）。运行等级缺失或为 0 时按建成等级算。
export function facilityCapacity(
  ticker: string,
  material: string,
  builtLevel: number,
  runLevel?: number,
): { reserve: number; next: number } | undefined {
  const per = FACILITY_CAPACITY[ticker]?.[material];
  if (per === undefined || builtLevel <= 0) {
    return undefined;
  }
  const run = runLevel !== undefined && runLevel > 0 ? runLevel : builtLevel;
  return { reserve: per.reserve * builtLevel, next: per.next * run };
}

// ── 输入 / 输出类型 ──────────────────────────────────────────────────────
// 政府基建设施内部存量：来自 POPID 每个建筑的维护供给表，
// 不是基地仓库库存。nextConsumption / reserve 对应「下一次消耗」「储备」两个
// progress 的当前值；*Capacity 对应它们的 max（游戏给出的满格容量）。
//
// 两个仓位的真实语义（2026-11-12 只读实测 VH-192b SST LV2 与 AW-844a SDP LV1）：
//   - 储备：30 天缓冲的量；容量 = 每级储备 × 建成等级；
//   - 下一次消耗：一个消耗周期（5 或 15 天，按「建筑 × 物料」不同）的量；
//     容量 = 每级周期量 × 运行等级。
// 两者都要从基地仓库填进去，消耗完「下一次消耗」后由「储备」自动转移补位。
// 所以「把这座建筑填满」= 填满两格 = 储备 30 天 + 一个完整周期，
// 只按 30 天备货会把「下一次消耗」这格空着，建筑还差一个周期才真正满仓。
export interface FacilityStock {
  nextConsumption: number;
  reserve: number;
  nextCapacity?: number;
  reserveCapacity?: number;
}

// 单座建筑内：物料 ticker -> 当前存量。
export type FacilityMaterialStocks = Record<string, FacilityStock>;
// 星球整体：建筑 ticker -> 物料 ticker -> 当前存量。
export type FacilityStocks = Record<string, FacilityMaterialStocks>;

export interface GovhInput {
  // 五类人口数量（来自 POPR 人口表）。
  population: Record<WorkforceLevel, number>;
  // 整星基地总数（含其他公司的基地），每座给 safety / health 各提供 50。
  // 必须用整星口径：POPR 的人口是全星球的，基础供给也是全星球共享的；
  // 只用自有基地数会把供给算少一个数量级（PR #60 审查 P2）。
  // 来源：星球聊天频道会员数（govh-base-count.ts），读不到时回退自有基地数。
  baseCount: number;
  // 游戏已算好的六类需求满足度 0~1（来自 POPR 需求满足度表，含封顶）。仅用于展示「现状」。
  currentFulfillment: Record<Need, number>;
  // 游戏已算好的五类人口幸福度 0~1（来自 POPR 幸福行）。仅用于展示「现状」。
  currentHappiness: Record<WorkforceLevel, number>;
  // 各建筑已建造等级（来自 LR「人口」的「建成」列）：ticker -> level。
  levels: Record<string, number>;
  // 各建筑已建造等级（LR「人口」的「建成」列）。只用于按建成等级推算储备容量：
  // 储备满格 = 每级储备 × 建成等级，与运行等级无关。
  // 缺省时用 levels（levels 传的是运行等级时会少算）。
  builtLevels?: Record<string, number>;
  // 各建筑当前运行等级（LR「人口」的「当前」列）。只用于「下一次消耗」那格容量
  // 按运行等级而非建成等级推算；缺省时按建成等级算。
  effectiveLevels?: Record<string, number>;
  // 政府基建设施内部「下一次消耗 + 储备」当前存量（来自 POPID 维护供给表）。
  // 只扣减一次性待补量，不影响需求贡献；缺省视为 0。
  facilityStocks?: FacilityStocks;
  // 维生预期。缺省 current；一句话说明见 LifeSupportAssumption。
  lifeSupportAssumption?: LifeSupportAssumption;
  // 补满范围：next = 只补「下一次消耗」（即时仓）；both = 即时仓 + 储备仓（缺省）。
  // 只影响待补量与成本口径，不参与需求满足度求解。
  fillScope?: FillScope;
  // 物料单价（从 cxobStore 实时盘口读），无报价为 undefined。
  prices: Record<string, number | undefined>;
  // 用户显式勾选的 (building, material) 键集合 `TICKER.MATERIAL`。
  // 传入时按其预览，不传时由求解器给出推荐集合。
  selected?: Set<string>;
  // 一次性把所有已建建筑的物料填满（预览上限）。
  fillAll?: boolean;
  // 物料重量/体积（来自 materialsStore），用于汇总。
  materialsInfo?: Record<string, { weight: number; volume: number }>;
}

export interface NeedState {
  needed: number;
  // 施加选中物料后的原始提供量（未封顶，与 needed 同单位）。
  provided: number;
  // 现状满足度（POPR 原值，含封顶）。
  current: number;
  // 按所选维生假设施加选中物料后的满足度（含封顶）。
  fulfillment: number;
  // 按 POPR 当前维生现值封顶、游戏此刻实际会显示的补足后满足度。
  // 与 fulfillment 分开，避免把「住房补齐后」的预测值当成事实。
  displayNow: number;
  // 是否在所选假设下被下一层短板封顶。
  capped: boolean;
}

export interface SupplyOption {
  // 唯一键 `BUILDING.MATERIAL`。
  key: string;
  building: string;
  buildingName: string;
  ticker: string;
  builtLevel: number;
  // 覆盖的基建需求。
  needs: InfraNeed[];
  // 每 1 级、该物料贡献的各类需求单位（= needs[need] / n）。
  contribPerLevel: Partial<Record<InfraNeed, number>>;
  price: number | undefined;
  // 满仓容量是否已知：POPID 两格 progress 的 max 没解析出来、容量表也查不到时
  // 为 false，该行待补量 / 成本 / 性价比全部显示「—」且不参与自动推荐。
  capacityKnown: boolean;
  // 满仓毛量 / 毛成本（未扣政府基建设施内部存量）。
  // 满仓 = POPID「下一次消耗 + 储备」两格都填满；容量取两格 progress 的 max，
  // POPID 没给到时用 FACILITY_CAPACITY 按等级推算。
  grossFillAmount: number;
  grossFillCost: number;
  // 目标星球该建筑该物料在「下一次消耗 / 储备」两栏的当前存量，非基地仓库。
  stockNextConsumption: number;
  stockReserve: number;
  stockTotal: number;
  // 实际待补量 / 待补成本 = max(0, 满仓毛量 − 上述两项存量)。
  netFillAmount: number;
  netFillCost: number;
  // 完整计算过程（带中文标签）：满仓量 X − 下一次消耗 Y − 储备 Z = 待补 W。
  // 保留给 CBUY 导出 / JSON 复制与模型单测；表格不再逐行展示这串长文字。
  calculation: string;
  // 表格「计算」列用的紧凑算式：`300−50−100=150`。
  // 表头与上方说明已交代各项含义，逐行只留数字与运算符，避免 20 行重复长文案。
  calculationCompact: string;
  // 该 option 全部覆盖需求在实际等级下的总贡献 / 本次待补成本（排序用；免费=Infinity，无报价/-1）。
  // Phase2 用它做粗排；Phase1 用 needEfficiency(option, need) 按当前短板需求精排。
  efficiency: number;
  selected: boolean;
}

export interface GovhResult {
  needs: Record<Need, NeedState>;
  // 施加选中物料后的五类人口幸福度 0~1。
  happiness: Record<WorkforceLevel, number>;
  // 全部 (building, material) 选项（含未选中，供「列全部物料自选」）。
  options: SupplyOption[];
  selected: Set<string>;
  summary: {
    // 选中物料的净待补成本合计（已扣设施内部存量）。
    fillCost: number;
    weight: number;
    volume: number;
    missingPrices: number;
    achievable: boolean;
    // 封顶短板需求（原始目标不可达时）。
    limitingNeed?: Need;
    // 维生预期派生值：UI 标注假设口径 / 告警文案 / 成本对照都读这里。
    assumption: LifeSupportAssumption;
    currentLifeSupport: number;
    lifeBaseline: number;
    effectiveTarget: number;
  };
}

// ── 纯函数 ──────────────────────────────────────────────────────────────
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
};

// 计算过程列的数字口径：整数不带小数，非整数保留 2 位，与面板 fixed0/fixed2 一致。
const formatQuantity = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

const safeStock = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;

// 五类人口对六类需求的「需求量」= Σ pop[level] × weight[level][need]。
export function computeNeeded(population: Record<WorkforceLevel, number>): Record<Need, number> {
  const result = {} as Record<Need, number>;
  for (const need of NEEDS) {
    result[need] = sum(
      LEVELS.map(level => (population[level] ?? 0) * HAPPINESS_WEIGHTS[level][need]),
    );
  }
  return result;
}

// 4 层封顶：高层不能超过其下一层最差的一项。
export function applyCapping(fulfillment: Record<Need, number>): {
  fulfillment: Record<Need, number>;
  capped: Record<Need, boolean>;
} {
  const result = { ...fulfillment } as Record<Need, number>;
  const capped = Object.fromEntries(NEEDS.map(need => [need, false])) as Record<Need, boolean>;
  for (let tier = 1; tier < TIERS.length; tier++) {
    const cap = Math.min(...TIERS[tier - 1].map(need => result[need]));
    for (const need of TIERS[tier]) {
      if (result[need] > cap) {
        result[need] = cap;
        capped[need] = true;
      }
    }
  }
  return { fulfillment: result, capped };
}

// 五类人口幸福度（needHappiness）= Σ weight[level][need] × fulfillment[need]。
export function computeHappiness(
  fulfillment: Record<Need, number>,
): Record<WorkforceLevel, number> {
  const result = {} as Record<WorkforceLevel, number>;
  for (const level of LEVELS) {
    result[level] = clamp01(
      sum(NEEDS.map(need => HAPPINESS_WEIGHTS[level][need] * fulfillment[need])),
    );
  }
  return result;
}

// 生成全部 (building, material) 选项（与 oog allOptions 对应）。
function buildOptions(input: GovhInput): SupplyOption[] {
  const options: SupplyOption[] = [];
  for (const building of UPKEEP_BUILDINGS) {
    const builtLevel = input.levels[building.ticker] ?? 0;
    if (builtLevel <= 0) {
      continue;
    }
    const n = building.materials.length;
    for (const material of building.materials) {
      const ticker = material;
      const contribPerLevel: Partial<Record<InfraNeed, number>> = {};
      for (const [need, amount] of Object.entries(building.needs) as [InfraNeed, number][]) {
        if (amount > 0) {
          contribPerLevel[need] = amount / n;
        }
      }
      const needs = Object.keys(contribPerLevel) as InfraNeed[];
      if (needs.length === 0) {
        continue;
      }
      const price = input.prices[ticker];
      const stock = input.facilityStocks?.[building.ticker]?.[ticker];
      // 满仓量取 POPID 两格 progress 的 max（游戏按等级算好的真实容量）：
      // 储备 = 30 天缓冲，下一次消耗 = 一个完整消耗周期，两格都填满才算满仓。
      // 容量表只在 POPID 的 max 没解析出来时补位；两者都没有就如实标记
      // 「容量未知」，不拿任何消耗速率去猜（本插件不使用日耗）。
      const stockNextCapacity = safeStock(stock?.nextCapacity);
      const stockReserveCapacity = safeStock(stock?.reserveCapacity);
      const stockNextConsumption = safeStock(stock?.nextConsumption);
      const stockReserve = safeStock(stock?.reserve);
      // 补满范围：next 档只补「下一次消耗」（即时仓），both 档两格都补。
      // 存量抵扣也按同一范围取，避免 next 档把储备仓里的料算进抵扣。
      const fillScope = input.fillScope ?? 'both';
      const measuredCapacity =
        fillScope === 'next' ? stockNextCapacity : stockNextCapacity + stockReserveCapacity;
      // 实测优先（POPID 两格 progress.max），缺失时用容量表按等级推算。
      const tableCapacity =
        measuredCapacity > 0
          ? undefined
          : facilityCapacity(
              building.ticker,
              ticker,
              input.builtLevels?.[building.ticker] ?? builtLevel,
              input.effectiveLevels?.[building.ticker] ?? builtLevel,
            );
      const capacity =
        measuredCapacity > 0
          ? measuredCapacity
          : tableCapacity === undefined
            ? 0
            : fillScope === 'next'
              ? tableCapacity.next
              : tableCapacity.reserve + tableCapacity.next;
      // 两处都拿不到容量就无法算待补量 → 整行标「—」、不参与自动推荐，
      // 由用户自己决定填多少（比按错误容量报一个假数字安全）。
      const capacityKnown = capacity > 0;
      const grossFillAmount = capacity;
      const stockTotal =
        fillScope === 'next' ? stockNextConsumption : stockNextConsumption + stockReserve;
      // 政府基建设施内部已有的「下一次消耗 + 储备」直接抵扣一次性采购量。
      const netFillAmount = capacityKnown ? Math.max(0, grossFillAmount - stockTotal) : 0;
      const grossFillCost = price !== undefined ? grossFillAmount * price : 0;
      const netFillCost = price !== undefined ? netFillAmount * price : 0;
      // contribPerLevel 是「每 1 级」的贡献，netFillCost 已含 builtLevel；
      // 性价比 = 这次一次性备货每花 1 credit 换到的需求单位，
      // 必须把贡献乘回实际等级，否则高等级建筑会被按 1/level 低估。
      const totalContrib = sum(needs.map(need => contribPerLevel[need] ?? 0)) * builtLevel;
      const efficiency =
        price === undefined || !capacityKnown
          ? -1
          : price === 0 || netFillCost === 0
            ? Infinity
            : totalContrib / netFillCost;
      options.push({
        key: `${building.ticker}.${ticker}`,
        building: building.ticker,
        buildingName: building.name,
        ticker,
        builtLevel,
        needs,
        contribPerLevel,
        price,
        capacityKnown,
        grossFillAmount,
        grossFillCost,
        stockNextConsumption,
        stockReserve,
        stockTotal,
        netFillAmount,
        netFillCost,
        calculation:
          fillScope === 'next'
            ? `即时仓 ${formatQuantity(grossFillAmount)} − 已备 ${formatQuantity(
                stockNextConsumption,
              )} = 待补 ${formatQuantity(netFillAmount)}`
            : `满仓量 ${formatQuantity(grossFillAmount)} − 下一次消耗 ${formatQuantity(
                stockNextConsumption,
              )} − 储备 ${formatQuantity(stockReserve)} = 待补 ${formatQuantity(netFillAmount)}`,
        calculationCompact:
          fillScope === 'next'
            ? `${formatQuantity(grossFillAmount)}−${formatQuantity(
                stockNextConsumption,
              )}=${formatQuantity(netFillAmount)}`
            : `${formatQuantity(grossFillAmount)}−${formatQuantity(
                stockNextConsumption,
              )}−${formatQuantity(stockReserve)}=${formatQuantity(netFillAmount)}`,
        efficiency,
        selected: false,
      });
    }
  }
  return options;
}

// 计算某组「待采购」选项下，各需求的最终提供量。
// 基准：
//   - 基地给 safety / health 各 50×baseCount（整星基地数，含他人基地）；
//   - 维生由住房 / 星球肥沃度决定，基建物料改变不了它，因此用所选
//     lifeBaseline（当前 POPR 现值或住房补齐后的 100%）作影子提供量；
//     取 0 会让 4 层封顶把全部需求误压成 0%；
//   - 已经满仓（netFillAmount = 0）的物料不需要再买，但设施里已有，
//     始终计入提供量，不受勾选状态影响。
function computeProvided(
  input: GovhInput,
  options: SupplyOption[],
  active: Set<string>,
  needed: Record<Need, number>,
  lifeBaseline: number,
): Record<Need, number> {
  const provided = Object.fromEntries(NEEDS.map(need => [need, 0])) as Record<Need, number>;
  const base = 50 * input.baseCount;
  provided.SAFETY = base;
  provided.HEALTH = base;
  provided.LIFE_SUPPORT = needed.LIFE_SUPPORT * lifeBaseline;
  for (const option of options) {
    // 已填满的存量是免费基线；未填满时必须显式采购才计入。
    // 容量未知的物料无法判断是否已填满，同样不能当免费基线（否则会凭空多算贡献）。
    if (!active.has(option.key) && (!option.capacityKnown || option.netFillAmount > 0)) {
      continue;
    }
    for (const [need, contrib] of Object.entries(option.contribPerLevel) as [InfraNeed, number][]) {
      provided[need] += contrib * option.builtLevel;
    }
  }
  return provided;
}

// 由提供量算封顶后满足度。维生不是物料提供的，直接覆写为所选假设基线；
// 无人口星球全项视为 1，避免被维生现值误压成「目标不可达」。
function cappingFromProvided(
  needed: Record<Need, number>,
  provided: Record<Need, number>,
  lifeBaseline: number,
): { fulfillment: Record<Need, number>; capped: Record<Need, boolean> } {
  const raw = {} as Record<Need, number>;
  for (const need of NEEDS) {
    raw[need] = needed[need] > 0 ? clamp01(provided[need] / needed[need]) : 1;
  }
  raw.LIFE_SUPPORT = needed.LIFE_SUPPORT > 0 ? lifeBaseline : 1;
  return applyCapping(raw);
}

// 达标判据必须与 Phase1 用同一个 effectiveTarget / lifeBaseline，
// 否则维生低于目标时封顶后恒 false，Phase2 会把每个待剔除物料立刻加回，
// 冗余剔除完全失效（历史 bug）。
function allTargetsMet(
  needed: Record<Need, number>,
  provided: Record<Need, number>,
  effectiveTarget: number,
  lifeBaseline: number,
): boolean {
  const { fulfillment } = cappingFromProvided(needed, provided, lifeBaseline);
  return INFRA_NEEDS.every(
    need => needed[need] <= 0 || fulfillment[need] >= effectiveTarget - 1e-9,
  );
}

// 当前需求维度上的「每 credit 贡献」。Phase1 必须按当前短板需求排序，
// 而不是按跨需求合计排序，否则一个总贡献高但对本需求低效的物料会挤掉真正便宜的选项。
function needEfficiency(option: SupplyOption, need: InfraNeed): number {
  if (option.price === undefined) {
    return -1;
  }
  const contrib = (option.contribPerLevel[need] ?? 0) * option.builtLevel;
  if (contrib <= 0) {
    return -1;
  }
  if (option.price === 0) {
    return Infinity;
  }
  return option.netFillCost > 0 ? contrib / option.netFillCost : -1;
}

function compareByEfficiency(a: number, b: number, direction: 'asc' | 'desc'): number {
  if (a === Infinity && b === Infinity) {
    return 0;
  }
  return direction === 'asc' ? a - b : b - a;
}

// ── 主求解 ──────────────────────────────────────────────────────────────
export function solve(input: GovhInput): GovhResult {
  // 目标满足度恒为 100%：面板定位「一个报告周期备足」，维生按所选
  // lifeSupportAssumption 派生基线（UI 默认 current，纯函数缺省 current），
  // 求解器不再接受任意 target，「省钱档 / 70%」旋钮已从设计与模型中移除。
  const target = 1;
  const assumption = input.lifeSupportAssumption ?? 'current';
  const currentLifeSupport = clamp01(input.currentFulfillment.LIFE_SUPPORT ?? 0);
  // 封顶基线与采购目标必须成对派生，Phase1 / Phase2 / 预览全部使用同一组。
  const lifeBaseline = assumption === 'full' ? 1 : currentLifeSupport;
  const effectiveTarget = assumption === 'full' ? target : Math.min(target, lifeBaseline);
  const needed = computeNeeded(input.population);
  const options = buildOptions(input);
  const optionByKey = new Map(options.map(o => [o.key, o]));

  let selected: Set<string>;
  if (input.selected !== undefined) {
    // 用户显式选择：仅保留仍存在的键。
    selected = new Set([...input.selected].filter(key => optionByKey.has(key)));
  } else if (input.fillAll) {
    selected = new Set(options.map(o => o.key));
  } else {
    // ── Phase 1：逐需求贪心（沿用 oog 两阶段思路）──────────────────────
    // 免费基线（已满仓的物料）由 computeProvided 自动计入，不需要采购，
    // 因此不进入 selected；selected 始终表示「这次真正要买的物料」。
    selected = new Set();
    for (const need of INFRA_NEEDS) {
      // 每轮按当前已选集合重算缺口：天然包含基地、维生基线、免费存量，
      // 以及之前需求选中的交叉贡献，避免重复采购。
      const providedNow = computeProvided(input, options, selected, needed, lifeBaseline);
      let remaining = needed[need] * effectiveTarget - providedNow[need];
      if (remaining <= 0) {
        continue;
      }
      const candidates = options
        .filter(
          o => o.netFillAmount > 0 && !selected.has(o.key) && (o.contribPerLevel[need] ?? 0) > 0,
        )
        // 按「当前短板需求」的每 credit 贡献降序；无报价排最后。
        .sort((a, b) =>
          compareByEfficiency(needEfficiency(a, need), needEfficiency(b, need), 'desc'),
        );
      for (const option of candidates) {
        if (remaining <= 0) {
          break;
        }
        selected.add(option.key);
        remaining -= (option.contribPerLevel[need] ?? 0) * option.builtLevel;
      }
    }

    // ── Phase 2：剔除冗余物料（避免超买）───────────────────────────────
    // 按总性价比从低到高尝试移除，移除后仍达标则永久移除。
    const removeOrder = [...selected].sort((a, b) =>
      compareByEfficiency(optionByKey.get(a)!.efficiency, optionByKey.get(b)!.efficiency, 'asc'),
    );
    for (const key of removeOrder) {
      selected.delete(key);
      const candidate = computeProvided(input, options, selected, needed, lifeBaseline);
      if (!allTargetsMet(needed, candidate, effectiveTarget, lifeBaseline)) {
        selected.add(key);
      }
    }
  }

  // ── 预览结果 ──────────────────────────────────────────────────────────
  // fulfillment = 按所选维生假设的预测值；displayNow = 游戏此刻实际显示值。
  const provided = computeProvided(input, options, selected, needed, lifeBaseline);
  const { fulfillment, capped } = cappingFromProvided(needed, provided, lifeBaseline);
  const displayNow = cappingFromProvided(needed, provided, currentLifeSupport).fulfillment;
  const happiness = computeHappiness(fulfillment);

  const needs = {} as Record<Need, NeedState>;
  for (const need of NEEDS) {
    needs[need] = {
      needed: needed[need],
      provided: provided[need],
      current: clamp01(input.currentFulfillment[need] ?? 0),
      fulfillment: clamp01(fulfillment[need]),
      displayNow: clamp01(displayNow[need]),
      capped: capped[need],
    };
  }

  let fillCost = 0;
  let weight = 0;
  let volume = 0;
  let missingPrices = 0;
  for (const option of options) {
    option.selected = selected.has(option.key);
    if (!option.selected) {
      continue;
    }
    if (option.price === undefined) {
      // 已填满的物料不需要报价（待补量为 0），不算缺价。
      if (option.netFillAmount > 0) {
        missingPrices++;
      }
      continue;
    }
    fillCost += option.netFillCost;
    const info = input.materialsInfo?.[option.ticker];
    if (info) {
      weight += info.weight * option.netFillAmount;
      volume += info.volume * option.netFillAmount;
    }
  }

  const achievable = allTargetsMet(needed, provided, effectiveTarget, lifeBaseline);
  // limitingNeed 仍按 100% 原目标诊断「哪一层让 100% 目标不可达」；
  // achievable 已按 effectiveTarget 判定，故 current 模式下两者可以并存
  // （已按 min 目标备足货，但原目标受维生限制），由 UI 分别显示提示与告警。
  let limitingNeed: Need | undefined;
  for (let tier = 1; tier < TIERS.length; tier++) {
    const lower = TIERS[tier - 1];
    const worst = lower.reduce(
      (acc, need) => (clamp01(fulfillment[need]) < clamp01(fulfillment[acc]) ? need : acc),
      lower[0],
    );
    if (clamp01(fulfillment[worst]) < target) {
      limitingNeed = worst;
      break;
    }
  }

  return {
    needs,
    happiness,
    options,
    selected,
    summary: {
      fillCost,
      weight,
      volume,
      missingPrices,
      achievable,
      limitingNeed,
      assumption,
      currentLifeSupport,
      lifeBaseline,
      effectiveTarget,
    },
  };
}
