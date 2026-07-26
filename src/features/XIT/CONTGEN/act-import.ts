// ACT JSON 导入 — 把任意 ACT 操作包/契约/物品清单 JSON 转成 CONTGEN 的
// items 列表（[{ticker, amount, price?}, ...]）。
//
// 设计要点：
//   • 借鉴 CART 的 parseCartImport 的递归 + 标准化思路，但不直接复用
//     其实现——CART 输出 CartItem 不含 price，而我们这里要保留每行价。
//   • 定义 5 类输入形态的"探测链"，覆盖社区脚本、CONTGEN 自身导出、
//     CART 导出、ACT 操作包、顶层 ticker 字典，详见 parseActJson。
//   • 失败信号走 throw，正常路径输出 ImportedContractItems——调用方
//     用 try/catch 把异常原样透给 UI。

const TICKER_PATTERN = /^[A-Z0-9-]+$/;

export interface ImportedRow {
  ticker: string;
  amount: number;
  price?: number;
}

export type ImportSource = 'array' | 'items' | 'materials' | 'actionPackage' | 'mixed';

export interface ImportedContractItems {
  rows: ImportedRow[];
  source: ImportSource;
  stats: {
    unique: number;
    totalUnits: number;
    // 含单价（满足 BUY/SELL validateConfig 不报错的最小条件）的行数
    withPrice: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 与 CART 同源：trim + 大写 + 字面模式校验。失败返回 undefined 而非抛错，
// 以便在聚合阶段静默丢弃错行，仅在最终 items 为空时统一报错。
function normalizeTicker(ticker: unknown): string | undefined {
  if (typeof ticker !== 'string') return undefined;
  const normalized = ticker.trim().toUpperCase();
  if (!normalized || !TICKER_PATTERN.test(normalized)) return undefined;
  return normalized;
}

// 与 CART 同源：向上取整、非正数丢弃。
function normalizeAmount(amount: unknown): number | undefined {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.ceil(numeric);
}

// price 不在 CART 的关注范围；按 PrUn 单价 2 位小数的步长四舍五入，避免
// 浮点尾差落到 CONTD 表单上时被 validateConfig 拒。
function normalizePrice(price: unknown): number | undefined {
  if (price === undefined || price === null) return undefined;
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.round(numeric * 100) / 100;
}

// 单行条目提取：支持 {ticker|commodity|material} + {amount|quantity} + price。
// allowTopLevelTicker 用于"顶层数组"分支——若 entry 只有一个 ticker-shaped
// key（形如 [ {"COF": 100} ]），也认作单行退化，避免误丢。
function extractRow(entry: unknown): ImportedRow | undefined {
  if (!isRecord(entry)) return undefined;
  const tickerRaw = entry.ticker ?? entry.commodity ?? entry.material ?? singleTickerHint(entry);
  const ticker = normalizeTicker(tickerRaw);
  const amount = normalizeAmount(entry.amount ?? entry.quantity);
  if (!ticker || amount === undefined) return undefined;
  const price = normalizePrice(entry.price ?? entry.unitPrice);
  const row: ImportedRow = { ticker, amount };
  if (price !== undefined) row.price = price;
  return row;
}

// 单键 hint：形如 { "COF": 100 }（一个 ticker-shaped key + 一个数字 value）。
// 这种情况不放进"items 数组"分支——后者已经是显式契约形态，不应再退化。
function singleTickerHint(entry: Record<string, unknown>): string | undefined {
  const keys = Object.keys(entry);
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  return TICKER_PATTERN.test(key.toUpperCase()) ? key : undefined;
}

// ticker 字典 → 行列表：典型输入是 { "COF": 100, "RAT": 50 } 或 groups[*].materials。
function extractFromDict(dict: unknown): ImportedRow[] {
  if (!isRecord(dict)) return [];
  const out: ImportedRow[] = [];
  for (const [k, v] of Object.entries(dict)) {
    const ticker = normalizeTicker(k);
    const amount = normalizeAmount(v);
    if (!ticker || amount === undefined) continue;
    out.push({ ticker, amount });
  }
  return out;
}

// 同一 ticker 多次出现时合并 amount；price 取最后一次出现的非空价。
function merge(rows: ImportedRow[]): ImportedRow[] {
  const merged = new Map<string, ImportedRow>();
  for (const row of rows) {
    const existing = merged.get(row.ticker);
    if (existing === undefined) {
      merged.set(row.ticker, { ...row });
      continue;
    }
    existing.amount += row.amount;
    if (row.price !== undefined) existing.price = row.price;
  }
  return Array.from(merged.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

// 输入形态探测链：数组 → items → materials → groups → 顶层 ticker 字典。
// 一旦命中即停止；都未命中抛"无法识别的 JSON 结构"。
export function parseActJson(source: unknown): ImportedContractItems {
  const rawRows: ImportedRow[] = [];
  let sourceTag: ImportSource = 'mixed';

  if (Array.isArray(source)) {
    for (const entry of source) {
      const row = extractRow(entry);
      if (row) rawRows.push(row);
    }
    sourceTag = 'array';
  } else if (isRecord(source)) {
    if (Array.isArray(source.items)) {
      for (const entry of source.items) {
        const row = extractRow(entry);
        if (row) rawRows.push(row);
      }
      sourceTag = 'items';
    } else if (isRecord(source.materials)) {
      rawRows.push(...extractFromDict(source.materials));
      sourceTag = 'materials';
    } else if (Array.isArray(source.groups)) {
      for (const group of source.groups) {
        if (isRecord(group)) rawRows.push(...extractFromDict(group.materials));
      }
      sourceTag = 'actionPackage';
    } else {
      // 顶层 ticker 字典:{ "COF": 100 }
      rawRows.push(...extractFromDict(source));
      sourceTag = 'mixed';
    }
  } else {
    throw new Error('无法识别的 JSON 结构');
  }

  const rows = merge(rawRows);
  if (rows.length === 0) {
    throw new Error('未找到有效物品');
  }

  return {
    rows,
    source: sourceTag,
    stats: {
      unique: rows.length,
      totalUnits: rows.reduce((s, r) => s + r.amount, 0),
      withPrice: rows.filter(r => typeof r.price === 'number').length,
    },
  };
}
