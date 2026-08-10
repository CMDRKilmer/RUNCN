import { compareMaterials } from '@src/core/sort-materials';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

type JsonRecord = Record<string, unknown>;

interface ImportState {
  name?: string;
  exchange?: string;
  materials: Map<string, number>;
}

export interface PurchaseDraftItem {
  ticker: string;
  amount: number;
  price: number;
}

export interface PurchaseDraftImport {
  name?: string;
  exchange?: string;
  items: PurchaseDraftItem[];
}

export interface PurchaseDraftPlan extends PurchaseDraftImport {
  deadline: number;
  location: string;
  recipient?: string;
}

export function parsePurchaseDraftImport(source: unknown): PurchaseDraftImport {
  const state: ImportState = {
    materials: new Map(),
  };

  visitSource(source, state);

  const items = normalizeItems(
    Array.from(state.materials, ([ticker, amount]) => ({
      ticker,
      amount,
      price: 1,
    })),
  );

  if (items.length === 0) {
    throw new Error('未在 JSON 中识别到采购物品。');
  }

  return {
    name: state.name,
    exchange: state.exchange,
    items,
  };
}

export function normalizePurchaseDraftName(name?: string | null) {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '采购合同草案';
}

export function normalizeItems(items: Iterable<Partial<PurchaseDraftItem>>) {
  const merged = new Map<string, number>();

  for (const item of items) {
    const ticker = normalizeTicker(item.ticker);
    const amount = normalizeAmount(item.amount);
    if (ticker === undefined || amount === undefined) {
      continue;
    }
    merged.set(ticker, (merged.get(ticker) ?? 0) + amount);
  }

  return Array.from(merged, ([ticker, amount]) => ({ ticker, amount, price: 1 })).sort((a, b) => {
    const byMaterial = compareMaterials(
      materialsStore.getByTicker(a.ticker),
      materialsStore.getByTicker(b.ticker),
    );
    return byMaterial !== 0 ? byMaterial : a.ticker.localeCompare(b.ticker);
  });
}

function visitSource(source: unknown, state: ImportState) {
  if (Array.isArray(source)) {
    for (const entry of source) {
      visitSource(entry, state);
    }
    return;
  }

  if (!isRecord(source)) {
    return;
  }

  if (!state.name) {
    state.name = asString((source.global as JsonRecord | undefined)?.name);
  }

  if (Array.isArray(source.actions) && Array.isArray(source.groups)) {
    mergeActionPackage(source, state);
    return;
  }

  mergeMaterialRecord(source, state.materials);
  mergeMaterialRecord(source.materials, state.materials);

  if (Array.isArray(source.groups)) {
    for (const group of source.groups) {
      if (isRecord(group)) {
        mergeMaterialRecord(group.materials, state.materials);
      }
    }
  }

  const ticker = normalizeTicker(asString(source.ticker));
  const amount = normalizeAmount(source.amount);
  if (ticker !== undefined && amount !== undefined) {
    state.materials.set(ticker, (state.materials.get(ticker) ?? 0) + amount);
  }
}

function mergeActionPackage(source: JsonRecord, state: ImportState) {
  const actions = source.actions as unknown[];
  const groups = source.groups as unknown[];
  const buyGroups = new Set<string>();

  for (const action of actions) {
    if (!isRecord(action)) {
      continue;
    }

    if (action.type !== 'CX Buy' && action.name !== 'BuyItems') {
      continue;
    }

    const group = asString(action.group);
    if (group) {
      buyGroups.add(group);
    }

    if (!state.exchange) {
      state.exchange = asString(action.exchange);
    }
  }

  for (const group of groups) {
    if (!isRecord(group)) {
      continue;
    }

    const groupName = asString(group.name);
    if (buyGroups.size > 0 && (!groupName || !buyGroups.has(groupName))) {
      continue;
    }

    mergeMaterialRecord(group.materials, state.materials);
  }
}

function mergeMaterialRecord(source: unknown, target: Map<string, number>) {
  if (!isRecord(source)) {
    return;
  }

  for (const [ticker, amount] of Object.entries(source)) {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedAmount = normalizeAmount(amount);
    if (normalizedTicker === undefined || normalizedAmount === undefined) {
      continue;
    }
    target.set(normalizedTicker, (target.get(normalizedTicker) ?? 0) + normalizedAmount);
  }
}

function normalizeTicker(ticker?: string | null) {
  const normalized = ticker?.trim().toUpperCase();
  if (!normalized || !/^[A-Z0-9-]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeAmount(amount: unknown) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.ceil(numeric);
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
