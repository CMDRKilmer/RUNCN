import { compareMaterials } from '@src/core/sort-materials';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';

type JsonRecord = Record<string, unknown>;

interface ImportState {
  name?: string;
  exchange?: string;
  materials: Map<string, number>;
}

export interface ImportedCartData {
  name?: string;
  exchange?: string;
  items: UserData.CartItem[];
}

export function defaultCartName() {
  return 'Shopping Cart';
}

export function normalizeCartName(name?: string | null) {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultCartName();
}

export function buildActionPackage(cart: UserData.ShoppingCartData) {
  const materials = toMaterialRecord(cart.items);
  const exchange = cart.exchange?.trim();
  if (!exchange || Object.keys(materials).length === 0) {
    return undefined;
  }

  const groupName = 'Cart';
  const name = normalizeCartName(cart.name);

  const pkg: UserData.ActionPackageData = {
    global: { name },
    groups: [
      {
        type: 'Manual',
        name: groupName,
        materials,
      },
    ],
    actions: [
      {
        type: 'CX Buy',
        name: 'BuyItems',
        group: groupName,
        exchange,
        priceLimits: {},
        buyPartial: false,
        allowUnfilled: false,
        useCXInv: true,
      },
      {
        type: 'MTRA',
        name: 'TransferAction',
        group: groupName,
        origin: getWarehouseName(exchange),
        dest: configurableValue,
      },
    ],
  };

  return pkg;
}

export function parseCartImport(source: unknown): ImportedCartData {
  const state: ImportState = {
    materials: new Map(),
  };

  visitSource(source, state);

  const items = normalizeCartItems(
    Array.from(state.materials, ([ticker, amount]) => ({
      ticker,
      amount,
    })),
  );

  if (items.length === 0) {
    throw new Error('No cart items found in JSON.');
  }

  return {
    name: state.name ? normalizeCartName(state.name) : undefined,
    exchange: state.exchange,
    items,
  };
}

export function normalizeCartItems(items: Iterable<Partial<UserData.CartItem>>) {
  const merged = new Map<string, number>();

  for (const item of items) {
    const ticker = normalizeTicker(item.ticker);
    const amount = normalizeAmount(item.amount);
    if (!ticker || amount === undefined || amount === null || amount <= 0) {
      continue;
    }
    merged.set(ticker, (merged.get(ticker) ?? 0) + amount);
  }

  return Array.from(merged, ([ticker, amount]) => ({ ticker, amount })).sort((a, b) => {
    const byMaterial = compareMaterials(
      materialsStore.getByTicker(a.ticker),
      materialsStore.getByTicker(b.ticker),
    );
    return byMaterial !== 0 ? byMaterial : a.ticker.localeCompare(b.ticker);
  });
}

export function getWarehouseName(exchangeCode?: string | null) {
  const stationName = getStationName(exchangeCode);
  return `${stationName ?? exchangeCode ?? 'Station'} Warehouse`;
}

export function getStationName(exchangeCode?: string | null) {
  const naturalId = exchangesStore.getNaturalIdFromCode(exchangeCode);
  return stationsStore.getByNaturalId(naturalId)?.name;
}

export function getExchangeOptions() {
  return (exchangesStore.all.value ?? [])
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(exchange => {
      const stationName = getStationName(exchange.code) ?? exchange.name;
      return {
        label: `${exchange.code} - ${stationName}`,
        value: exchange.code,
      };
    });
}

function visitSource(source: unknown, state: ImportState) {
  if (Array.isArray(source)) {
    for (const entry of source) {
      visitSource(entry, state);
    }
    return;
  }

  if (!source || typeof source !== 'object') {
    return;
  }

  const record = source as JsonRecord;

  if (!state.name) {
    const globalName = asString((record.global as JsonRecord | undefined)?.name);
    if (globalName) {
      state.name = globalName;
    }
  }

  if (!state.exchange) {
    const directExchange = asString(record.exchange);
    if (directExchange) {
      state.exchange = directExchange;
    }
  }

  mergeMaterialRecord(record, state.materials);
  mergeMaterialRecord(record.materials, state.materials);

  if (Array.isArray(record.groups)) {
    for (const group of record.groups) {
      if (!group || typeof group !== 'object') {
        continue;
      }
      mergeMaterialRecord((group as JsonRecord).materials, state.materials);
    }
  }

  if (Array.isArray(record.actions) && !state.exchange) {
    state.exchange = inferExchangeFromActions(record.actions);
  }

  const ticker = normalizeTicker(asString(record.ticker));
  const amount = normalizeAmount(record.amount);
  if (ticker && amount !== undefined && amount !== null && amount > 0) {
    state.materials.set(ticker, (state.materials.get(ticker) ?? 0) + amount);
  }
}

function mergeMaterialRecord(source: unknown, target: Map<string, number>) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return;
  }

  for (const [ticker, amount] of Object.entries(source as JsonRecord)) {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedAmount = normalizeAmount(amount);
    if (
      !normalizedTicker ||
      normalizedAmount === undefined ||
      normalizedAmount === null ||
      normalizedAmount <= 0
    ) {
      continue;
    }
    target.set(normalizedTicker, (target.get(normalizedTicker) ?? 0) + normalizedAmount);
  }
}

function inferExchangeFromActions(actions: unknown[]) {
  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      continue;
    }
    const record = action as JsonRecord;
    if (record.type === 'CX Buy') {
      const exchange = asString(record.exchange);
      if (exchange) {
        return exchange;
      }
    }
  }

  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      continue;
    }
    const record = action as JsonRecord;
    if (record.type !== 'MTRA') {
      continue;
    }
    const exchange = inferExchangeFromOrigin(asString(record.origin));
    if (exchange) {
      return exchange;
    }
  }

  return undefined;
}

function inferExchangeFromOrigin(origin?: string) {
  if (!origin) {
    return undefined;
  }

  const stationName = origin.endsWith(' Warehouse')
    ? origin.substring(0, origin.length - ' Warehouse'.length).trim()
    : origin.trim();

  const naturalId = stationsStore.getNaturalIdFromName(stationName);
  return naturalId ? exchangesStore.getByNaturalId(naturalId)?.code : undefined;
}

function toMaterialRecord(items: Iterable<UserData.CartItem>) {
  const materials: Record<string, number> = {};

  for (const item of items) {
    const ticker = normalizeTicker(item.ticker);
    const amount = normalizeAmount(item.amount);
    if (!ticker || amount === undefined || amount === null || amount <= 0) {
      continue;
    }
    materials[ticker] = (materials[ticker] ?? 0) + amount;
  }

  return materials;
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
  return typeof value === 'string' ? value : undefined;
}
