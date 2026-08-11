// 将存储数据解析为库存名称（非 MTRA 库存名称）
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import {
  getEntityNameFromAddress,
  getLocationLineFromAddress,
  isSameAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';

export function serializeStorage(storage: PrunApi.Store) {
  switch (storage.type) {
    case 'STL_FUEL_STORE':
      return storage.name + ' STL Store';
    case 'FTL_FUEL_STORE':
      return storage.name + ' FTL Store';
    case 'SHIP_STORE':
      return storage.name + ' Cargo';
    case 'STORE': {
      const site = sitesStore.getById(storage.addressableId);
      return getEntityNameFromAddress(site?.address) + ' Base';
    }
    case 'WAREHOUSE_STORE': {
      const warehouse = warehousesStore.getById(storage.addressableId);
      return getEntityNameFromAddress(warehouse?.address) + ' Warehouse';
    }
  }

  return 'Error, unable to serialize';
}

export function deserializeStorage(serializedName: string | undefined) {
  if (!serializedName) {
    return undefined;
  }
  // 优先按 store ID 直解析：仓库/飞船等目标以 store ID 标识时，
  // 不受实体重命名影响（与 INV <store-id> 同一套权威标识）。
  const byId = storagesStore.getById(serializedName);
  if (byId) {
    return byId;
  }
  let name: string | undefined;
  name = extractName(serializedName, 'Base');
  if (name) {
    const site = sitesStore.getByPlanetNaturalIdOrName(name);
    return storagesStore.getByAddressableId(site?.siteId)?.find(x => x.type === 'STORE');
  }
  name = extractName(serializedName, 'Warehouse');
  if (name) {
    const warehouse = warehousesStore.getByEntityNaturalIdOrName(name);
    return storagesStore
      .getByAddressableId(warehouse?.warehouseId)
      ?.find(x => x.type === 'WAREHOUSE_STORE');
  }
  name = extractName(serializedName, 'Cargo');
  if (name) {
    return storagesStore.getByName(name)?.find(x => x.type === 'SHIP_STORE');
  }
  name = extractName(serializedName, 'FTL Store');
  if (name) {
    return storagesStore.getByName(name)?.find(x => x.type === 'FTL_FUEL_STORE');
  }
  name = extractName(serializedName, 'STL Store');
  if (name) {
    return storagesStore.getByName(name)?.find(x => x.type === 'STL_FUEL_STORE');
  }

  return undefined;
}

function extractName(name: string, suffix: string) {
  return name.endsWith(suffix) ? name.replace(' ' + suffix, '') : undefined;
}

// 序列化存储名的可读显示：store ID 形式时反解为名称形式。
export function storageDisplayName(name: string | undefined) {
  if (!name || name === configurableValue) {
    return name;
  }
  const store = deserializeStorage(name);
  return store ? serializeStorage(store) : name;
}

// 根据类型对存储进行排序
export function storageSort(a: PrunApi.Store, b: PrunApi.Store) {
  const storagePriorityMap = {
    FTL_FUEL_STORE: 5,
    STL_FUEL_STORE: 4,
    SHIP_STORE: 3,
    STORE: 1,
    WAREHOUSE_STORE: 2,
  };
  const priorityA = isCXWarehouse(a) ? 0 : (storagePriorityMap[a.type] ?? 6);
  const priorityB = isCXWarehouse(b) ? 0 : (storagePriorityMap[b.type] ?? 6);
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  return serializeStorage(a).localeCompare(serializeStorage(b));
}

export function isCXWarehouse(storage: PrunApi.Store) {
  if (storage.type !== 'WAREHOUSE_STORE') {
    return false;
  }

  const warehouse = warehousesStore.getById(storage.addressableId);
  const location = getLocationLineFromAddress(warehouse?.address);
  return location?.type === 'STATION';
}

export function atSameLocation(storageA: PrunApi.Store, storageB: PrunApi.Store) {
  if (storageA === storageB) {
    return false;
  }

  const addressA = getStoreAddress(storageA);
  const addressB = getStoreAddress(storageB);

  return isSameAddress(addressA, addressB);
}

function getStoreAddress(store: PrunApi.Store) {
  switch (store.type) {
    case 'STORE': {
      const site = sitesStore.getById(store.addressableId);
      return site?.address;
    }
    case 'WAREHOUSE_STORE': {
      const warehouse = warehousesStore.getById(store.addressableId);
      return warehouse?.address;
    }
    case 'SHIP_STORE':
    case 'STL_FUEL_STORE':
    case 'FTL_FUEL_STORE': {
      const ship = shipsStore.getById(store.addressableId);
      return ship?.address;
    }
    default:
      return undefined;
  }
}
