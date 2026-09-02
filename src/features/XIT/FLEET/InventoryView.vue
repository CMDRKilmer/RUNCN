<script setup lang="ts">
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
  isStationLine,
  getLocationLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import RadioItem from '@src/components/forms/RadioItem.vue';
import InvBar from '@src/features/XIT/FLEET/InvBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { useTileState } from '@src/store/user-data-tiles';
import fa from '@src/utils/font-awesome.module.css';

type InvType = 'BASE' | 'SHIP' | 'WAREHOUSE' | 'CX';

const TYPE_ORDER: Record<InvType, number> = { CX: 0, BASE: 1, SHIP: 2, WAREHOUSE: 3 };
const TYPE_LABELS: Record<InvType, string> = {
  BASE: 'BS',
  SHIP: 'SHP',
  WAREHOUSE: 'WAR',
  CX: 'CX',
};

interface InvRow {
  storeId: string;
  type: InvType;
  label: string;
  naturalId?: string;
  warehousePlanetId?: string;
  onClickCmd: string;
}

const showBase = useTileState('invShowBase', true);
const showShip = useTileState('invShowShip', true);
const showWarehouse = useTileState('invShowWarehouse', true);
const showCx = useTileState('invShowCx', true);
const showBaseWar = useTileState('invShowBaseWar', true);
const locationFilter = ref('');

const basePlanetIds = computed(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return new Set<string>();
  }
  return new Set(
    sites
      .map(site => getEntityNaturalIdFromAddress(site.address))
      .filter((id): id is string => !!id),
  );
});

const allRows = computed<InvRow[] | undefined>(() => {
  const stores = storagesStore.nonFuelStores.value;
  const sites = sitesStore.all.value;
  const ships = shipsStore.all.value;
  const warehouses = warehousesStore.all.value;

  if (!stores || !sites || !ships || !warehouses) {
    return undefined;
  }

  const rows: InvRow[] = [];

  for (const store of stores) {
    if (store.type === 'STORE') {
      const site = sitesStore.getById(store.addressableId);
      if (!site) {
        continue;
      }
      const naturalId = getEntityNaturalIdFromAddress(site.address);
      if (!naturalId) {
        continue;
      }
      rows.push({
        storeId: store.id,
        type: 'BASE',
        label: getEntityNameFromAddress(site.address) ?? naturalId,
        naturalId,
        onClickCmd: `INV ${store.id.substring(0, 8)}`,
      });
    } else if (store.type === 'SHIP_STORE') {
      const ship = ships.find(s => s.idShipStore === store.id);
      if (!ship) {
        continue;
      }
      rows.push({
        storeId: store.id,
        type: 'SHIP',
        label: ship.name || ship.registration,
        onClickCmd: `SHPI ${ship.registration}`,
      });
    } else if (store.type === 'WAREHOUSE_STORE') {
      const warehouse = warehouses.find(w => w.storeId === store.id);
      if (!warehouse) {
        continue;
      }
      const locationLine = getLocationLineFromAddress(warehouse.address);
      const isCx = isStationLine(locationLine);
      const naturalId = getEntityNaturalIdFromAddress(warehouse.address);
      const label = getEntityNameFromAddress(warehouse.address) ?? naturalId ?? 'Unknown';
      rows.push({
        storeId: store.id,
        type: isCx ? 'CX' : 'WAREHOUSE',
        label,
        warehousePlanetId: isCx ? undefined : naturalId,
        onClickCmd: `INV ${store.id.substring(0, 8)}`,
      });
    }
  }

  rows.sort((a, b) => {
    const typeOrder = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    if (typeOrder !== 0) {
      return typeOrder;
    }
    // 星球行显示代码，按代码排序；其余按名称。
    const key = (row: InvRow) => (row.type === 'BASE' && row.naturalId ? row.naturalId : row.label);
    return key(a).localeCompare(key(b));
  });

  return rows;
});

const filteredRows = computed(() => {
  const rows = allRows.value;
  if (!rows) {
    return undefined;
  }

  const query = locationFilter.value.trim().toUpperCase();

  return rows.filter(row => {
    if (row.type === 'BASE' && !showBase.value) {
      return false;
    }
    if (row.type === 'SHIP' && !showShip.value) {
      return false;
    }
    if (row.type === 'WAREHOUSE' && !showWarehouse.value) {
      return false;
    }
    if (row.type === 'CX' && !showCx.value) {
      return false;
    }
    if (!showBaseWar.value && row.type === 'WAREHOUSE' && row.warehousePlanetId) {
      if (basePlanetIds.value.has(row.warehousePlanetId)) {
        return false;
      }
    }
    if (
      query &&
      !row.label.toUpperCase().includes(query) &&
      !(row.naturalId ?? '').toUpperCase().includes(query)
    ) {
      return false;
    }
    return true;
  });
});
</script>

<template>
  <div :class="$style.layout">
    <LoadingSpinner v-if="!filteredRows" />
    <template v-else>
      <div :class="C.ComExOrdersPanel.filter">
        <RadioItem v-model="showCx" horizontal>CX</RadioItem>
        <RadioItem v-model="showBase" horizontal>BS</RadioItem>
        <RadioItem v-model="showShip" horizontal>SHP</RadioItem>
        <RadioItem v-model="showWarehouse" horizontal>WAR</RadioItem>
        <div :class="$style.separator" />
        <RadioItem v-model="showBaseWar" horizontal>基地仓储</RadioItem>
        <div :class="$style.spacer" />
        <div :class="$style.searchContainer">
          <input
            v-model="locationFilter"
            type="text"
            autocomplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            placeholder="输入位置"
            :class="$style.searchInput" />
          <PrunButton
            v-if="locationFilter"
            dark
            :class="[fa.solid, $style.clearButton]"
            @click="locationFilter = ''">
            {{ '' }}
          </PrunButton>
        </div>
      </div>
      <div :class="$style.scroll">
        <table :class="$style.table">
          <thead>
            <tr>
              <th :class="$style.nameCol">名称</th>
              <th :class="$style.typeCol">类型</th>
              <th :class="$style.barCol">库存</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredRows" :key="row.storeId" :class="$style.row">
              <td :class="$style.nameCell">
                <span :class="$style.nameText" @click="showBuffer(row.onClickCmd)">
                  <template v-if="row.naturalId">
                    {{ row.naturalId }}<BaseAlias :natural-id="row.naturalId" />
                  </template>
                  <template v-else>{{ row.label }}</template>
                </span>
              </td>
              <td :class="$style.typeCell">{{ TYPE_LABELS[row.type] }}</td>
              <td :class="$style.barCell">
                <InvBar
                  :store-id="row.storeId"
                  :natural-id="row.naturalId"
                  :on-click-cmd="row.onClickCmd" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style module>
.layout {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
}

.scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

/* 细窄深色滚动条（游戏/项目风格） */
.scroll {
  scrollbar-width: thin;
  scrollbar-color: rgb(61, 74, 84) rgb(26, 33, 38);
}

.scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.scroll::-webkit-scrollbar-track {
  background: rgb(26, 33, 38);
}

.scroll::-webkit-scrollbar-thumb {
  background: rgb(61, 74, 84);
  border-radius: 4px;
}

.scroll::-webkit-scrollbar-thumb:hover {
  background: rgb(90, 105, 118);
}

.separator {
  width: 1px;
  align-self: stretch;
  background-color: #2b485a;
  margin: 0 0.25rem;
}

.spacer {
  flex: 1;
}

.searchContainer {
  display: flex;
  align-items: center;
}

.searchInput {
  background-color: #42361d;
  border-width: 0 0 1px;
  border-bottom: 1px solid #8d6411;
  color: #cccccc;
  padding: 0 5px;

  &::placeholder {
    color: #666;
  }

  &:focus {
    outline: none;
  }
}

.clearButton {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-left: 2px;
  width: 18px;
  height: 18px;
  font-size: 11px;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.nameCol {
  padding: 4px 6px;
}

.typeCol {
  width: 0;
  white-space: nowrap;
}

.barCol {
  min-width: 80px;
}

.row {
  border-bottom: 1px solid #2b485a;
}

.nameCell {
  width: 1px;
  padding: 4px 6px;
}

.nameText {
  display: block;
  max-width: 200px;
  font-weight: bold;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.typeCell {
  padding: 4px 6px;
  text-align: center;
  font-size: 11px;
  font-weight: bold;
}

.barCell {
  padding: 4px 6px;
  width: 100%;
}
</style>
