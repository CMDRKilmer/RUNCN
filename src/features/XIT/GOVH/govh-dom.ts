// XIT GOVH 的本地 DOM 取数层。
//
// 数据来源全部是游戏原生窗口，无任何外部请求：
//   - POPR <星球>：五类人口、五类幸福度、六类需求满足度（游戏已算好，含封顶）。
//   - POPI <星球>：14 座基建建筑的「已建造」等级（仅当 LR 不可用时回退）。
//   - POPID p-<星球> t-<建筑>：各建筑维护供给表里的「下一次消耗 / 储备」当前存量。
//   - LR <星球>「人口」标签：14 座建筑的建成 / 当前 / 目标等级、上一周期贡献率、
//     以及「需求满足度（上一周期）」原文本。
//   - LR <星球>「项目」标签：当前项目 / 即办项目的类别、项目、说明与原样倒计时。
//
// 取数机制与底栏换汇 / BPC/BMAT 一致：用 showBuffer 开一个 hidden 窗口
// （buffers.ts 会隐藏窗口与 dock 按钮，不闪），等原生表格 DOM 出现后解析，
// closeWhen 满足时窗口自动关闭。不抢前台、不下单。LR 是例外：只在这个自建的
// hidden 窗口内依序切「人口」「项目」两个标签读数据，读完即关，不改玩家自己的窗口。
// 一次 LR 开窗同时替代了原来的 POPI 开窗，冷读少一个窗口。
//
// 解析只用语义类（C.Population.table / container）与表头/行首文本，不写死
// CSS module hash；解析失败给出明确错误，由面板层降级提示，绝不连 FIO。

import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sleep } from '@src/utils/sleep';
import {
  LEVELS,
  NEEDS,
  LEVEL_LABELS,
  NEED_LABELS,
  UPKEEP_BUILDINGS,
  facilityCapacity,
  type FacilityMaterialStocks,
  type FacilityStocks,
  type Need,
  type WorkforceLevel,
} from './govh-model';
import { parseReportAge, reportCacheRemainingMs, type ReportAge } from './govh-report-age';

// 中英双语表头标签：游戏语言可能是中文或英文，表头文本用任一命中即可。
const LEVEL_HEADERS: Record<WorkforceLevel, string[]> = {
  PIONEER: [LEVEL_LABELS.PIONEER, 'Pioneer'],
  SETTLER: [LEVEL_LABELS.SETTLER, 'Settler'],
  TECHNICIAN: [LEVEL_LABELS.TECHNICIAN, 'Technician', '职技工'],
  ENGINEER: [LEVEL_LABELS.ENGINEER, 'Engineer'],
  SCIENTIST: [LEVEL_LABELS.SCIENTIST, 'Scientist'],
};
const NEED_HEADERS: Record<Need, string[]> = {
  LIFE_SUPPORT: [NEED_LABELS.LIFE_SUPPORT, 'Life Support'],
  SAFETY: [NEED_LABELS.SAFETY, 'Safety'],
  HEALTH: [NEED_LABELS.HEALTH, 'Health'],
  COMFORT: [NEED_LABELS.COMFORT, 'Comfort'],
  CULTURE: [NEED_LABELS.CULTURE, 'Culture'],
  EDUCATION: [NEED_LABELS.EDUCATION, 'Education'],
};
// 本地化需求名 -> Need：LR「贡献（上一周期）」单元格里是「安全 - 98.7%」这类文本。
const NEED_BY_LABEL = new Map<string, Need>(
  NEEDS.flatMap(need => NEED_HEADERS[need].map(label => [label, need] as [string, Need])),
);
// LR 的两个标签（中文 / 英文界面都能命中）。
const LR_POPULATION_TAB = /^(人口|Population)$/i;
const LR_PROJECTS_TAB = /^(项目|Projects)$/i;
// 行首标签：中文 / 英文（POPR 行首是「人口」「幸福」「需求满足度」）。
const ROW_POPULATION = ['人口', 'Population'];
const ROW_HAPPINESS = ['幸福', 'Happiness'];
const ROW_FULFILLMENT = ['需求满足度', 'Needs Fulfillment', 'Need Fulfillment'];
// POPID 维护供给表表头。只取「下一次消耗 / 储备」两个进度条的 value，
// 不读「库存」或「贡献」，那两列不是用户要求扣除的设施内部存量。
const STOCK_NEXT_HEADERS = ['下一次消耗', 'Next Consumption'];
const STOCK_RESERVE_HEADERS = ['储备', 'Reserve'];

// 本期 POPR 报告的一行明细，保留游戏原生显示文本（含 "-- / -1" 与 "%"）。
export interface PopulationReportRow {
  label: string;
  values: Record<WorkforceLevel, string>;
}

// POPR 底部的管理方项目（可选，部分星球没有）。LR 读取失败时面板降级显示这一行。
export interface GovernanceProject {
  name: string;
  description: string;
}

// LR「项目」标签里一组项目的四个原生字段。
// time 原样保留游戏倒计时文本（当期「结束于」如 "4天 19小时"、即办「开始于」，
// 无项目时为 "--"），不换算成绝对日期、不重新格式化。
export interface GovernanceProjectEntry {
  category: string;
  name: string;
  description: string;
  time: string;
}

export interface GovernanceProjects {
  current?: GovernanceProjectEntry;
  pending?: GovernanceProjectEntry;
}

// LR「人口」标签「基础设施项目」表的一行。
// built  = 已建成等级（POPI「已建造」同源，决定建筑是否存在、是否开 POPID 窗口）；
// current= 上一周期实际运行等级（目标降级 / 断供时会小于 built，求解必须用它，
//          否则按 built 全额估算 provided 会系统性高估）；
// target = 目标等级原文本（"max" 或数字）。2026-11-12 起**不再参与任何计算与展示**
//          （用户裁定「目标等级那段没有意义」），只留作口径核对与验收对照，
//          同时也是识别该表表头结构的判据之一。
// contributions = 「贡献（上一周期）」按需求拆分的运行率 0~1（物料齐备度，不是满足度）。
export interface InfraLevel {
  ticker: string;
  built: number;
  current: number;
  target: string;
  contributions: Partial<Record<Need, number>>;
}

export interface InfraReport {
  levels: InfraLevel[];
  // 「需求满足度（上一周期）」六类原生文本，仅供口径核对与验收，不参与求解。
  lastPeriodFulfillmentText: Partial<Record<Need, string>>;
}

// 一次 LR 开窗依序读到的两个标签（任一都允许读不到，面板分别降级）。
export interface LrReadResult {
  infra?: InfraReport;
  projects?: GovernanceProjects;
}

export interface GovhSnapshot {
  planet: string;
  // 五类人口数量。
  population: Record<WorkforceLevel, number>;
  // 五类人口幸福度 0~1（POPR 游戏值）。
  happiness: Record<WorkforceLevel, number>;
  // 六类需求满足度 0~1（POPR 游戏值，含封顶）。
  fulfillment: Record<Need, number>;
  // 六类需求满足度的原生显示文本（含 "--"），面板直接展示本期原值。
  fulfillmentText: Record<Need, string>;
  // POPR 报告明细：人口 / 变更 / 移民 / 教育（增/减）/ 幸福 / 失业 / 待聘。
  reportRows: PopulationReportRow[];
  // 报告编号与时间，如 "报告#43/3天 13小时前"。
  reportLabel?: string;
  // 管理方项目，POPR 底部可选区块。
  project?: GovernanceProject;
  // LR「项目」标签的当期 / 即办项目（可选；读不到时面板降级回上面的单行）。
  projects?: GovernanceProjects;
  // 14 座建筑的已建造等级：ticker -> level（LR「建成」列或回退 POPI）。
  levels: Record<string, number>;
  // 求解用的有效运行等级：ticker -> level。来自 LR「当前」列；LR 不可用时缺省，
  // 调用方回退到 levels（已建造），保持旧行为。
  effectiveLevels?: Record<string, number>;
  // LR「人口」标签的建成 / 当前 / 目标与上一周期贡献率（可选增强）。
  infra?: InfraReport;
  // 各已建建筑内，每种物料的「下一次消耗 + 储备」当前存量。
  facilityStocks: FacilityStocks;
}

const POPR_TIMEOUT = 12000;
const POPI_TIMEOUT = 12000;
const POPID_TIMEOUT = 9000;
// 一次开窗要依序切两个标签并等各自 React 渲染，比单标签留更多余量。
const LR_TIMEOUT = 15000;

// 把 "1,995" / "86.0%" / "--" 解析为数字；无法解析返回 undefined。
function parseNumber(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const cleaned = text.trim().replace(/[,%\s]/g, '');
  if (cleaned === '' || cleaned === '--' || cleaned === '-') {
    return undefined;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

// 去掉 ⓘ 等提示图标与空白。
function cleanLabel(text: string | undefined): string {
  return (text ?? '').replace(/[ⓘ\u200b]/g, '').trim();
}

// 在窗口内找原生 Population 表格。
// POPR / POPI 的表格带 `Population__table` 语义类，但 POPID 的维护供给表只是
// 普通 <table>（实测没有该类）。优先用语义类，找不到时回退到原生 table，
// 表头判断仍由各解析器负责，不会误把其它表格当数据。
function populationTables(window: HTMLElement): HTMLTableElement[] {
  const container = C.Population.container ? _$(window, C.Population.container) : undefined;
  const scope = container ?? window;
  const semantic = C.Population.table ? (_$$(scope, C.Population.table) as HTMLTableElement[]) : [];
  return semantic.length > 0 ? semantic : (_$$(scope, 'table') as HTMLTableElement[]);
}

function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll('tr'));
}

function cellsOf(row: HTMLTableRowElement): string[] {
  return Array.from(row.children).map(cell => cleanLabel(cell.textContent ?? ''));
}

// 等待窗口出现且表格数据就绪，然后解析；超时返回 undefined。
// prepare 只用于 LR：开窗后切到「项目」标签。每轮轮询都会调用，实现必须幂等
// （已激活就直接返回），否则 React 重绘期间会反复点击。POPR / POPI / POPID 不传。
//
// 窗口一律取 showBuffer 的返回值，不再「按 before 集合猜新窗口」：
// buffers.ts 的 acquireSlot 是串行队列，两次 GOVH 读取重叠时两边都会在窗口创建前
// 抓同一份 before，猜窗口就会拿到另一次为别的星球开的窗口；parsePopr 又会把结果
// 贴上本次请求的星球名，于是新的一次读取会显示并缓存旧星球的人口与采购需求
// （loadSeq 拦不住，因为数据确实「读到了」）。见 PR #60 审查 P1。
async function withBuffer<T>(
  command: string,
  timeout: number,
  parse: (window: HTMLElement) => T | undefined,
  prepare?: (window: HTMLElement) => void,
): Promise<T | undefined> {
  const ready = ref(false);
  const deadline = Date.now() + timeout;
  // 兜底：showBuffer 内部还要等 Dock 的「新建」按钮与串行队列，极端情况下可能
  // 久等不到。超时后先返回，finally 里的 ready=true 仍会让它自己开完再关掉。
  const created = await Promise.race([
    showBuffer(command, {
      force: true,
      autoClose: true,
      closeWhen: computed(() => ready.value),
    }),
    sleep(timeout).then(() => undefined),
  ]);
  try {
    if (!created) {
      return undefined;
    }
    while (Date.now() < deadline) {
      // 游戏把无法识别的指令渲染成空标题的「无效指令」窗口。快速失败，
      // 否则逐建筑读取时每座都要空等整个超时，面板会长时间停在「读取中…」。
      const text = created.textContent ?? '';
      if (text.includes('无效指令') || /invalid command/i.test(text)) {
        return undefined;
      }
      prepare?.(created);
      const result = parse(created);
      if (result !== undefined) {
        return result;
      }
      await sleep(150);
    }
    return undefined;
  } finally {
    // 无论成功超时都让 hidden 窗口关闭，避免残留。
    ready.value = true;
    if (created) {
      // buffers.ts 的 processWindow 只 `void closeWhenDone()`，showBuffer 会在真正的
      // 关闭动画完成前就释放串行队列。必须等本次窗口从 DOM 断开，
      // 否则下一个 POPID 窗口会抢到正在关闭的壳，命令标题是空的（实测会卡住）。
      for (let i = 0; i < 30 && created.isConnected; i++) {
        await sleep(50);
      }
      // 窗口 DOM 断开后，PrUn 内部的 tile id → 窗口映射还会晚一拍更新。
      // 连续开多个 hidden 窗口时留一个短暂 settle 窗口给游戏自己收敛
      // （不抢前台、不额外开窗）。实测 250ms 足够，避免逐建筑读取累加等待。
      await sleep(250);
    }
  }
}

// 解析 POPR 人口报告。
function parsePopr(window: HTMLElement, planet: string): GovhSnapshot | undefined {
  const tables = populationTables(window);
  if (tables.length < 2) {
    return undefined;
  }
  // 人口表：表头含先驱者标签；需求表：表头含维生标签。
  const hasHeader = (table: HTMLTableElement, labels: string[]) =>
    labels.some(label => (rowsOf(table)[0]?.textContent ?? '').includes(label));
  const popTable = tables.find(t => hasHeader(t, LEVEL_HEADERS.PIONEER));
  const needTable = tables.find(t => hasHeader(t, NEED_HEADERS.LIFE_SUPPORT));
  if (!popTable || !needTable) {
    return undefined;
  }

  // 人口表：表头行给出列顺序（本地化标签 → LEVELS）。
  const header = cellsOf(rowsOf(popTable)[0]);
  const levelColumns = new Map<WorkforceLevel, number>();
  for (let i = 1; i < header.length; i++) {
    const label = header[i];
    const level = LEVELS.find(l => LEVEL_HEADERS[l].includes(label));
    if (level) {
      levelColumns.set(level, i);
    }
  }
  if (levelColumns.size !== LEVELS.length) {
    return undefined;
  }

  const population = Object.fromEntries(LEVELS.map(l => [l, 0])) as Record<WorkforceLevel, number>;
  const happiness = Object.fromEntries(LEVELS.map(l => [l, 0])) as Record<WorkforceLevel, number>;
  // 本期报告明细：逐行保留游戏原生显示文本，直接给面板展示，不二次格式化。
  const reportRows: PopulationReportRow[] = [];
  let hasPopulation = false;
  for (const row of rowsOf(popTable).slice(1)) {
    const cells = cellsOf(row);
    const label = cells[0] ?? '';
    if (label !== '') {
      const values = Object.fromEntries(
        LEVELS.map(level => [level, cells[levelColumns.get(level) ?? -1] ?? '—']),
      ) as Record<WorkforceLevel, string>;
      reportRows.push({ label, values });
    }
    if (matchesRow(label, ROW_POPULATION)) {
      for (const [level, col] of levelColumns) {
        population[level] = parseNumber(cells[col]) ?? 0;
      }
      hasPopulation = true;
    } else if (matchesRow(label, ROW_HAPPINESS)) {
      for (const [level, col] of levelColumns) {
        const pct = parseNumber(cells[col]);
        happiness[level] = pct === undefined ? 0 : pct / 100;
      }
    }
  }
  if (!hasPopulation) {
    return undefined;
  }

  // 需求表：表头给出六类列，数据行「需求满足度」。
  const needHeader = cellsOf(rowsOf(needTable)[0]);
  const needColumns = new Map<Need, number>();
  for (let i = 1; i < needHeader.length; i++) {
    const label = needHeader[i];
    const need = NEEDS.find(n => NEED_HEADERS[n].includes(label));
    if (need) {
      needColumns.set(need, i);
    }
  }
  const fulfillment = Object.fromEntries(NEEDS.map(n => [n, 0])) as Record<Need, number>;
  const fulfillmentText = Object.fromEntries(NEEDS.map(n => [n, '--'])) as Record<Need, string>;
  let hasFulfillment = false;
  for (const row of rowsOf(needTable).slice(1)) {
    if (!matchesRow(cellsOf(row)[0] ?? '', ROW_FULFILLMENT)) {
      continue;
    }
    const cells = cellsOf(row);
    for (const [need, col] of needColumns) {
      const pct = parseNumber(cells[col]);
      fulfillment[need] = pct === undefined ? 0 : pct / 100;
      fulfillmentText[need] = cells[col] ?? '--';
    }
    hasFulfillment = true;
  }
  if (!hasFulfillment) {
    return undefined;
  }

  return {
    planet,
    population,
    happiness,
    fulfillment,
    fulfillmentText,
    reportRows,
    reportLabel: parseReportLabel(window),
    project: parseGovernanceProject(window),
    levels: {},
    facilityStocks: {},
  };
}

// 行首标签匹配（去掉 ⓘ 后，中英任一前缀命中）。
function matchesRow(label: string, candidates: string[]): boolean {
  return candidates.some(candidate => label.startsWith(candidate));
}

// 从 POPR 顶部控制条读取「报告#43/3天 13小时前」，不读折线图日期轴。
function parseReportLabel(window: HTMLElement): string | undefined {
  const controls = C.Population.controls ? _$(window, C.Population.controls) : undefined;
  if (!controls) {
    return undefined;
  }
  const text = _$$(controls, 'span')
    .map(span => cleanLabel(span.textContent ?? undefined))
    .find(value => /报告\s*#|Report\s*#/i.test(value));
  return text || undefined;
}

// ── POPR 按人口报告周期缓存 ─────────────────────────────────────────────
// 五类人口 / 五类幸福度 / 六类需求满足度在一个报告周期内是固定值（周期 7 天整），
// 只有跨周期才会变。每颗星球的周期起止时刻不同，所以缓存按星球独立，并用 POPR
// 顶部「报告#43/5天 13小时前」的生成时长反推本期结束时刻：
//   本期结束 = 现在 + (7 天 − 报告年龄 − 该标签的取整精度)
// 同一周期内再进面板直接复用，不再开 POPR 窗口；跨周期自动失效并重读。
// 报告年龄解析与「剩余可用时长」都在 govh-report-age.ts（纯函数，可单测）：
// 标签只到小时，剩余时长按年龄区间上界算，宁可早失效也不跨周期复用。
const POPR_CACHE_PREFIX = 'rprun.govh.popr.v1.';

function readPoprCycleCache(planet: string): GovhSnapshot | undefined {
  try {
    const raw = localStorage.getItem(POPR_CACHE_PREFIX + planet.toUpperCase());
    if (raw === null) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { snapshot?: GovhSnapshot; endsAt?: unknown } | null;
    if (parsed === null || parsed.snapshot === undefined || typeof parsed.endsAt !== 'number') {
      return undefined;
    }
    if (parsed.snapshot.planet?.toLowerCase() !== planet.toLowerCase()) {
      return undefined;
    }
    if (Date.now() >= parsed.endsAt) {
      localStorage.removeItem(POPR_CACHE_PREFIX + planet.toUpperCase());
      return undefined;
    }
    return parsed.snapshot;
  } catch {
    // 隐私模式 / 脏数据：当作没有缓存，走实时读取。
    return undefined;
  }
}

function writePoprCycleCache(
  planet: string,
  snapshot: GovhSnapshot,
  age: ReportAge | undefined,
): void {
  if (age === undefined || age.ageMs < 0) {
    return;
  }
  // 按年龄区间上界算剩余：取整精度内任何一刻都可能已经 rollover。
  const remaining = reportCacheRemainingMs(age);
  // 剩余不足一个取整精度（或已过期）说明马上要换周期，宁可不缓存。
  if (remaining <= 0) {
    return;
  }
  try {
    localStorage.setItem(
      POPR_CACHE_PREFIX + planet.toUpperCase(),
      JSON.stringify({ snapshot, endsAt: Date.now() + remaining }),
    );
  } catch {
    // 写不进去就每次重读，不影响功能。
  }
}

// 从 POPR 底部「管理方项目」读取项目名与说明（没有该区块时返回 undefined）。
function parseGovernanceProject(window: HTMLElement): GovernanceProject | undefined {
  const header = (_$$(window, 'div') as HTMLElement[]).find(
    element =>
      element.children.length === 0 &&
      /^(管理方项目|Governor Project)$/i.test(cleanLabel(element.textContent ?? undefined)),
  );
  if (!header) {
    return undefined;
  }
  let name = '';
  let description = '';
  let node = header.nextElementSibling;
  while (node) {
    const label = cleanLabel(_$(node, 'label')?.textContent ?? '');
    const value = cleanLabel(_$(node, '[class*="StaticInput__static"]')?.textContent ?? '');
    if (/^(项目|Project)$/i.test(label)) {
      name = value;
    } else if (/^(说明|Description)$/i.test(label)) {
      description = value;
    }
    node = node.nextElementSibling;
  }
  return name ? { name, description } : undefined;
}

// LR 标签只在这个 hidden 窗口内切换，不动玩家自己的窗口。
// 标签是 <a class="Tabs__tab___...">，激活态多一个 Tabs__tabActive；
// 用 a[class*="Tabs__tab"] 避开同样含 "Tabs__tab" 前缀的 Tabs__tabs 容器。
function activeLrTab(window: HTMLElement): string {
  const tab = window.querySelector('a[class*="Tabs__tabActive"]');
  return cleanLabel(tab?.textContent ?? '');
}

function clickLrTab(window: HTMLElement, pattern: RegExp): void {
  if (pattern.test(activeLrTab(window))) {
    return;
  }
  const tabs = Array.from(window.querySelectorAll('a[class*="Tabs__tab"]')) as HTMLElement[];
  const target = tabs.find(tab => pattern.test(cleanLabel(tab.textContent ?? '')));
  target?.click();
}

// LR 项目标签的 DOM：SectionHeader「当前项目」/「即办项目」/「曾办项目」，
// 每个项目区块是 4 个连续的 FormComponent 静态字段（类别 / 项目 / 说明 /
// 结束于·开始于），字段值在 [class*="StaticInput__static"] 里。
// 按固定顺序取值而不是按本地化标签匹配：中英文界面都能读，且不会把
// 「曾办项目」表格混进来（遇到下一个 SectionHeader 即停）。
function parseLrProjects(window: HTMLElement): GovernanceProjects | undefined {
  const active = window.querySelector('a[class*="Tabs__tabActive"]');
  if (!active || !/^(项目|Projects)$/i.test(cleanLabel(active.textContent ?? ''))) {
    return undefined;
  }
  const content = window.querySelector('[class*="Tabs__content"]');
  if (!content) {
    return undefined;
  }
  const headers = Array.from(
    content.querySelectorAll('[class*="SectionHeader__container"]'),
  ) as HTMLElement[];
  if (headers.length < 2) {
    return undefined;
  }
  const readSection = (header: HTMLElement): GovernanceProjectEntry | undefined => {
    const values: string[] = [];
    let node = header.nextElementSibling as HTMLElement | null;
    while (node && !node.matches('[class*="SectionHeader__container"]')) {
      const value = node.querySelector('[class*="StaticInput__static"]');
      if (value) {
        values.push(cleanLabel(value.textContent ?? ''));
      }
      node = node.nextElementSibling as HTMLElement | null;
    }
    if (values.length < 4) {
      return undefined;
    }
    return {
      category: values[0],
      name: values[1],
      description: values[2],
      time: values[3],
    };
  };
  const current = readSection(headers[0]);
  const pending = readSection(headers[1]);
  return current || pending ? { current, pending } : undefined;
}

// 「贡献（上一周期）」单元格：<div class="LocalRules__container">
//   <span><span>安全</span> - 98.7%</span><span><span>文化</span> - 100.0%</span>
// 多需求建筑（ACA / EMC / WCE / PBH）会有多个 span。百分比是该建筑上一周期的
// 物料齐备度 / 运行率，不是占总需求的比例，也不是满足度——只作展示对照，
// 绝不乘进求解系数（一次性断供不是永久折损，乘进去会导致重复采购）。
function parseLrContributions(cell: HTMLElement | undefined): Partial<Record<Need, number>> {
  const result: Partial<Record<Need, number>> = {};
  if (!cell) {
    return result;
  }
  const container = cell.querySelector('[class*="LocalRules__container"]');
  if (!container) {
    return result;
  }
  for (const span of Array.from(container.children)) {
    const text = cleanLabel(span.textContent ?? '');
    const label = cleanLabel(span.querySelector('span')?.textContent ?? text.split('-')[0] ?? '');
    const need = NEED_BY_LABEL.get(label);
    const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (need && pct) {
      result[need] = Number(pct[1]) / 100;
    }
  }
  return result;
}

// LR「人口」标签：两张原生表——「基础设施项目」（14 行：基础设施 / 建成 / 当前 /
// 目标ⓘ / 贡献（上一周期））与「需求满足度（上一周期）」（六类原文本）。
// 表头按中英文本定位列，不写死 CSS module hash；解析不出 14 行就返回 undefined，
// 由 readGovernanceSnapshot 回退 POPI，绝不把半张表当成完整等级数据。
function parseLrInfra(window: HTMLElement): InfraReport | undefined {
  if (!LR_POPULATION_TAB.test(activeLrTab(window))) {
    return undefined;
  }
  const tables = Array.from(window.querySelectorAll('table')) as HTMLTableElement[];
  const infraTable = tables.find(table => {
    const header = rowsOf(table)[0]?.textContent ?? '';
    return (
      /建成|Built/i.test(header) &&
      /当前|Current/i.test(header) &&
      /目标|Target/i.test(header) &&
      /贡献|Contribution/i.test(header)
    );
  });
  if (!infraTable) {
    return undefined;
  }
  const header = cellsOf(rowsOf(infraTable)[0]);
  const column = (pattern: RegExp) => header.findIndex(cell => pattern.test(cell));
  const nameCol = column(/基础设施|Infrastructure|^Name$|^名称$/i);
  const builtCol = column(/^建成$|^Built$/i);
  const currentCol = column(/^当前$|^Current$/i);
  const targetCol = column(/^目标$|^Target$/i);
  const contributionCol = column(/贡献|Contribution/i);
  if (nameCol < 0 || builtCol < 0 || currentCol < 0 || targetCol < 0 || contributionCol < 0) {
    return undefined;
  }

  const levels: InfraLevel[] = [];
  for (const row of rowsOf(infraTable).slice(1)) {
    const cells = Array.from(row.children) as HTMLElement[];
    const ticker = NAME_TO_TICKER.get(cleanLabel(cells[nameCol]?.textContent ?? ''));
    if (!ticker) {
      continue;
    }
    levels.push({
      ticker,
      built: parseNumber(cells[builtCol]?.textContent ?? undefined) ?? 0,
      current: parseNumber(cells[currentCol]?.textContent ?? undefined) ?? 0,
      target: cleanLabel(cells[targetCol]?.textContent ?? ''),
      contributions: parseLrContributions(cells[contributionCol]),
    });
  }
  if (levels.length === 0) {
    return undefined;
  }

  // 「需求满足度（上一周期）」：只保留游戏原文本，供口径核对，不参与求解。
  const lastPeriodFulfillmentText: Partial<Record<Need, string>> = {};
  const fulfillmentTable = tables.find(table => {
    const firstHeader = cellsOf(rowsOf(table)[0]);
    return (
      firstHeader.some(cell => NEED_BY_LABEL.has(cell)) &&
      /需求满足度|Needs Fulfillment/i.test(table.textContent ?? '')
    );
  });
  if (fulfillmentTable) {
    const fHeader = cellsOf(rowsOf(fulfillmentTable)[0]);
    const fColumns = new Map<Need, number>();
    for (let i = 0; i < fHeader.length; i++) {
      const need = NEED_BY_LABEL.get(fHeader[i]);
      if (need) {
        fColumns.set(need, i);
      }
    }
    const fRow = rowsOf(fulfillmentTable)
      .slice(1)
      .find(row => /需求满足度|Needs Fulfillment/i.test(cellsOf(row)[0] ?? ''));
    if (fRow) {
      const cells = cellsOf(fRow);
      for (const [need, col] of fColumns) {
        lastPeriodFulfillmentText[need] = cells[col] ?? '--';
      }
    }
  }
  return { levels, lastPeriodFulfillmentText };
}

// 「项目」标签内容是否真的渲染出来：人口标签也有 SectionHeader，必须用项目专属标题
// 区分，否则 React 切标签的那一轮会把旧内容误判为已就绪、丢掉项目数据。
function isLrProjectsRendered(window: HTMLElement): boolean {
  if (!LR_PROJECTS_TAB.test(activeLrTab(window))) {
    return false;
  }
  const content = window.querySelector('[class*="Tabs__content"]');
  if (!content) {
    return false;
  }
  return Array.from(content.querySelectorAll('[class*="SectionHeader__container"]')).some(header =>
    /当前项目|即办项目|曾办项目|Current Project|Pending Project|Past Project/i.test(
      cleanLabel(header.textContent ?? ''),
    ),
  );
}

// 一次 LR 开窗依序读「人口」与「项目」两个标签。prepare 只负责切标签（幂等），
// parse 按当前激活标签把数据存进闭包；两阶段都完成才返回。任一标签渲染不出来时
// 软降级（对应字段 undefined），不拖死整次冷读、也不影响玩家自己的窗口。
async function readLr(planet: string): Promise<LrReadResult | undefined> {
  let infra: InfraReport | undefined;
  let projects: GovernanceProjects | undefined;
  let infraDone = false;
  let projectsDone = false;
  let populationWaits = 0;
  let projectsWaits = 0;
  const MAX_TAB_WAITS = 24; // 每轮 150ms，约 3.6s

  return withBuffer<LrReadResult>(
    `LR ${planet}`,
    LR_TIMEOUT,
    window => {
      const active = activeLrTab(window);
      if (!infraDone && LR_POPULATION_TAB.test(active)) {
        infra = parseLrInfra(window) ?? infra;
        if (infra || populationWaits >= MAX_TAB_WAITS) {
          infraDone = true;
        }
      }
      if (infraDone && !projectsDone && LR_PROJECTS_TAB.test(active)) {
        if (isLrProjectsRendered(window) || projectsWaits >= MAX_TAB_WAITS) {
          projects = parseLrProjects(window);
          projectsDone = true;
        }
      }
      if (!infraDone || !projectsDone) {
        return undefined;
      }
      return { infra, projects };
    },
    window => {
      const active = activeLrTab(window);
      if (!infraDone) {
        if (LR_POPULATION_TAB.test(active)) {
          populationWaits++;
        } else {
          clickLrTab(window, LR_POPULATION_TAB);
        }
        return;
      }
      if (!projectsDone) {
        if (LR_PROJECTS_TAB.test(active)) {
          projectsWaits++;
        } else {
          clickLrTab(window, LR_PROJECTS_TAB);
        }
      }
    },
  );
}

// 建筑名 -> ticker（中文名 + 英文名双映射到固化表）。
const NAME_TO_TICKER = new Map<string, string>(
  UPKEEP_BUILDINGS.flatMap(
    b =>
      [
        [b.name, b.ticker],
        [b.enName, b.ticker],
        [b.enName.toUpperCase(), b.ticker],
      ] as [string, string][],
  ),
);

// 解析 POPI 基建列表（已建造等级）。
function parsePopi(window: HTMLElement): Record<string, number> | undefined {
  const tables = populationTables(window);
  const table = tables.find(t => {
    const header = rowsOf(t)[0]?.textContent ?? '';
    return (
      (header.includes('已建造') || header.includes('Built')) &&
      (header.includes('名称') || header.includes('Name'))
    );
  });
  if (!table) {
    return undefined;
  }
  const levels: Record<string, number> = {};
  const rows = rowsOf(table);
  let parsed = 0;
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row);
    if (cells.length < 2) {
      continue;
    }
    const ticker = NAME_TO_TICKER.get(cells[0]);
    if (!ticker) {
      continue;
    }
    levels[ticker] = parseNumber(cells[1]) ?? 0;
    parsed++;
  }
  return parsed > 0 ? levels : undefined;
}

// 读取 POPID 维护供给表中某一列 progress 的当前 value。
// 「下一次消耗」单元格内还有倒计时文本，必须取 progress 而不是整格数字。
function parseProgressValue(cell: Element | undefined): number {
  const progress = cell?.querySelector('progress');
  if (!progress) {
    return 0;
  }
  const raw = progress.getAttribute('value') ?? (progress as HTMLProgressElement).value;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

// 读取同一列 progress 的满格容量（max）。
// 游戏在这里给出按等级算好的真实两格容量（储备 / 下一次消耗），直接拿来当满仓量；
// 这里只读数值，不涉及任何消耗速率。
function parseProgressCapacity(cell: Element | undefined): number {
  const progress = cell?.querySelector('progress');
  if (!progress) {
    return 0;
  }
  const raw = progress.getAttribute('max') ?? (progress as HTMLProgressElement).max;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

// 物料 ticker：优先语义类，回退到原生 ColoredIcon 类与首格文本（如 "DW315" → "DW"）。
function materialTicker(row: HTMLTableRowElement): string {
  const bySemantic = C.ColoredIcon.label
    ? (_$(row, C.ColoredIcon.label)?.textContent?.trim() ?? '')
    : '';
  if (/^[A-Za-z0-9]{1,8}$/.test(bySemantic)) {
    return bySemantic;
  }
  const byClass = _$(row, '[class*="ColoredIcon__label"]')?.textContent?.trim() ?? '';
  if (/^[A-Za-z0-9]{1,8}$/.test(byClass)) {
    return byClass;
  }
  const firstCell = cleanLabel(row.children[0]?.textContent ?? '');
  return firstCell.match(/^([A-Za-z]{1,8})/)?.[1] ?? '';
}

// 解析 `POPID p-<planet> t-<building>` 的维护供给表。
// 只读「下一次消耗 / 储备」两个进度条的当前值，不读「库存 / 贡献」。
function parsePopidStock(window: HTMLElement): FacilityMaterialStocks | undefined {
  const table = populationTables(window).find(t => {
    const header = rowsOf(t)[0]?.textContent ?? '';
    return (
      STOCK_NEXT_HEADERS.some(label => header.includes(label)) &&
      STOCK_RESERVE_HEADERS.some(label => header.includes(label))
    );
  });
  if (!table) {
    return undefined;
  }
  const header = cellsOf(rowsOf(table)[0]);
  const nextCol = header.findIndex(cell => STOCK_NEXT_HEADERS.some(label => cell.includes(label)));
  const reserveCol = header.findIndex(cell =>
    STOCK_RESERVE_HEADERS.some(label => cell.includes(label)),
  );
  if (nextCol < 0 || reserveCol < 0) {
    return undefined;
  }

  const stocks: FacilityMaterialStocks = {};
  let parsed = 0;
  for (const row of rowsOf(table).slice(1)) {
    // 物料 ticker 在 ColoredIcon 的 label 里；td.textContent 还混着库存角标数字。
    const ticker = materialTicker(row);
    if (ticker === '') {
      continue;
    }
    const cells = Array.from(row.children);
    stocks[ticker] = {
      nextConsumption: parseProgressValue(cells[nextCol]),
      reserve: parseProgressValue(cells[reserveCol]),
      nextCapacity: parseProgressCapacity(cells[nextCol]),
      reserveCapacity: parseProgressCapacity(cells[reserveCol]),
    };
    parsed++;
  }
  return parsed > 0 ? stocks : undefined;
}

// 最近一次读取失败的具体原因（给面板提示用）。成功或取走即清空。
let lastFailure: string | undefined;

// 满仓量「表 vs 实测」不一致的物料（去重）。表是固化常量，游戏改数值或表本身
// 写错时会走到这里；此时按实测值算，避免静默按错表给出偏大 / 偏小的待补量。
const capacityMismatches = new Set<string>();

export function takeCapacityMismatches(): string[] {
  const list = [...capacityMismatches];
  capacityMismatches.clear();
  return list;
}

// 用本地每级容量表覆盖每个物料的满仓两格容量。
//
// 为什么：容量 = 每级容量 × 等级，等级只有 1~10 且严格线性（2026-11-13 实测
// 71/71），所以不需要每次开 POPID 解析 progress.max 才能拿到满仓量。这样即使
// 某格进度条的 max 没解析出来，也不会退化成任何按速率自算的旧口径。
// 两格用的不是同一个等级：储备按建成等级，下一次消耗按运行等级（LR「当前」列），
// 所以运行等级未知时不算表——用建成等级猜会让下一次消耗偏大。
//
// 表算值优先；一旦与实测冲突则信实测（游戏本身），并记一条差异供诊断。
function applyCapacityTable(
  stocks: FacilityStocks,
  levels: Record<string, number>,
  effectiveLevels: Record<string, number> | undefined,
): void {
  if (effectiveLevels === undefined) {
    return;
  }
  for (const [ticker, materials] of Object.entries(stocks)) {
    const built = levels[ticker] ?? 0;
    for (const [material, stock] of Object.entries(materials)) {
      const predicted = facilityCapacity(ticker, material, built, effectiveLevels[ticker]);
      if (predicted === undefined) {
        continue;
      }
      const measuredReserve = stock.reserveCapacity;
      const measuredNext = stock.nextCapacity;
      const conflicts =
        (measuredReserve !== undefined && measuredReserve !== predicted.reserve) ||
        (measuredNext !== undefined && measuredNext !== predicted.next);
      if (conflicts) {
        capacityMismatches.add(`${ticker}.${material}`);
        stock.reserveCapacity = measuredReserve ?? predicted.reserve;
        stock.nextCapacity = measuredNext ?? predicted.next;
        continue;
      }
      stock.reserveCapacity = predicted.reserve;
      stock.nextCapacity = predicted.next;
    }
  }
}

export function takeReadFailure(): string | undefined {
  const failure = lastFailure;
  lastFailure = undefined;
  return failure;
}

// 整次快照读取的全局串行锁。
// 页面里可能同时存在多个 GOVH 面板（独立窗口、FB 面板内嵌、用户自己开好几个），
// 它们各自读快照时会互相抢 hidden 窗口：POPR / LR / 逐建筑 POPID 的轮询一旦交叉，
// 后来的那次很容易拿不到某座建筑的维护表；而「缺一座就拒收」之后，整块面板会直接
// 报读取失败。串行化后窗口不交叉，也让「绑定 showBuffer 返回窗口」这条更稳。
let readChain: Promise<unknown> = Promise.resolve();

function withSnapshotLock<T>(task: () => Promise<T>): Promise<T> {
  // then 的双回调形式：上一个任务失败也不能把后面的锁打断。
  const run = readChain.then(task, task);
  readChain = run.catch(() => undefined);
  return run;
}

// 从游戏本地 DOM 读取某星球的治理现状。
// 依次打开 POPR、LR（一次开窗读完「人口」+「项目」两个标签）、每个已建建筑的
// POPID hidden 窗口；LR 读到基础设施表时不再开 POPI（少一个窗口），读不到才回退 POPI。
// 关键数据失败返回 undefined（面板降级提示），绝不按 0 存量静默给出偏大清单。
// LR 是可选增强：读不到「项目」时面板降级回 POPR 的单行项目；读不到「人口」时
// effectiveLevels 缺省、求解回退已建造等级，保持旧行为。两者都不阻断主流程。
export function readGovernanceSnapshot(
  planet: string,
  force = false,
): Promise<GovhSnapshot | undefined> {
  return withSnapshotLock(() => readGovernanceSnapshotLocked(planet, force));
}

async function readGovernanceSnapshotLocked(
  planet: string,
  force: boolean,
): Promise<GovhSnapshot | undefined> {
  // 星球编码保留玩家输入的原样（PrUn natural ID 大小写敏感，如 VH-192b）。
  const target = planet.trim();
  if (target === '') {
    return undefined;
  }
  // 人口 / 幸福度 / 六类满足度在一个报告周期内是固定值：周期内直接复用上一次读到的
  // POPR 结果，不再开窗；跨周期缓存自动失效。「刷新数据」按钮（force）强制重读。
  let popr = force ? undefined : readPoprCycleCache(target);
  if (!popr) {
    const read = await withBuffer<{ snapshot: GovhSnapshot; age: ReportAge | undefined }>(
      `POPR ${target}`,
      POPR_TIMEOUT,
      window => {
        const snapshot = parsePopr(window, target);
        if (!snapshot) {
          return undefined;
        }
        return { snapshot, age: parseReportAge(snapshot.reportLabel) };
      },
    );
    if (!read) {
      lastFailure = `POPR ${target} 的人口 / 需求满足度表没读到`;
      return undefined;
    }
    popr = read.snapshot;
    writePoprCycleCache(target, popr, read.age);
  }
  const lr = await readLr(target);
  const infra = lr?.infra;
  // 「建成」列与 POPI「已建造」同源（14/14 实测一致），可直接替代 POPI 开窗。
  const levels: Record<string, number> | undefined = infra
    ? Object.fromEntries(infra.levels.map(entry => [entry.ticker, entry.built]))
    : await withBuffer(`POPI ${target}`, POPI_TIMEOUT, parsePopi);
  if (!levels) {
    lastFailure = `POPI ${target} 的已建造等级没读到`;
    return undefined;
  }
  // 「当前」列是上一周期实际运行等级：目标降级 / 断供时会小于建成等级，
  // 求解必须按它算贡献（容量另按建成 / 运行等级分别推算），
  // 否则按建成等级全额估算会系统性高估 provided。
  const effectiveLevels: Record<string, number> | undefined = infra
    ? Object.fromEntries(infra.levels.map(entry => [entry.ticker, entry.current]))
    : undefined;

  // 逐建筑打开 POPID 详情窗口。汇总命令 `POPID p-<planet>` 不带维护供给表，
  // 必须带 `t-<ticker>`；只读取已建建筑，避免无谓窗口。
  const built = UPKEEP_BUILDINGS.filter(b => (levels[b.ticker] ?? 0) > 0);
  const facilityStocks: FacilityStocks = {};
  const readStocks = async (ticker: string) => {
    const stocks = await withBuffer(
      // POPID 必须带 `p-` 星球前缀；不带前缀会被游戏判为「无效指令」。
      `POPID p-${target} t-${ticker}`,
      POPID_TIMEOUT,
      parsePopidStock,
    );
    if (stocks) {
      facilityStocks[ticker] = stocks;
    }
    return stocks !== undefined;
  };
  for (const building of built) {
    await readStocks(building.ticker);
  }
  // 缺哪座就单独重试哪座（最多 3 轮）：hidden 窗口偶尔会被并发的其它读窗挤掉，
  // 一次失败不代表数据真的读不到。
  for (let attempt = 0; attempt < 2; attempt++) {
    const missing = built.filter(building => facilityStocks[building.ticker] === undefined);
    if (missing.length === 0) {
      break;
    }
    await sleep(400);
    for (const building of missing) {
      await readStocks(building.ticker);
    }
  }
  // 仍有建筑没读到就整份拒收，绝不能放行：
  // 缺失建筑在 safeStock(stock?.reserve / nextConsumption) 里会变成 0 存量，
  // 于是「已经存了不少料」的建筑被当成空仓、推荐买满一份，而且这份不完整快照
  // 还会被写进缓存（PR #60 审查 P2）。宁可让面板提示读取失败。
  const missing = built.filter(building => facilityStocks[building.ticker] === undefined);
  if (missing.length > 0) {
    lastFailure = `已建建筑 ${missing.map(building => building.ticker).join(' / ')} 的 POPID 维护供给表没读到`;
    return undefined;
  }
  // 满仓量改用本地对照表算（POPID 只保证当前存量）。表外建筑保留实测容量。
  applyCapacityTable(facilityStocks, levels, effectiveLevels);
  return {
    ...popr,
    levels,
    effectiveLevels,
    infra,
    facilityStocks,
    projects: lr?.projects,
  };
}
