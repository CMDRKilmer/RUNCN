import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getLocationLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import ContextControlsItem from '@src/components/ContextControlsItem.vue';

async function onTileReady(tile: PrunTile) {
  const ship = computed(() => shipsStore.getByRegistration(tile.parameter));

  const locationNaturalId = computed(() => {
    if (ship.value?.flightId !== null) {
      return undefined;
    }
    const location = getLocationLineFromAddress(ship.value.address ?? undefined);
    return location?.entity.naturalId ?? undefined;
  });

  const warehouseStore = computed(() => {
    const warehouse = warehousesStore.getByEntityNaturalId(locationNaturalId.value);
    return storagesStore.getById(warehouse?.storeId);
  });

  const contextBar = await $(tile.frame, C.ContextControls.container);

  createFragmentApp(() => {
    const war = warehouseStore.value;
    const id = locationNaturalId.value;
    if (!war || !id) {
      return null;
    }
    return <ContextControlsItem cmd={`INV ${war.id.substring(0, 8)}`} cmdText={`WAR ${id}`} />;
  }).prependTo(contextBar);
}

function init() {
  tiles.observe('SHPI', onTileReady);
}

features.add(import.meta.url, init, 'SHPI：当飞船停靠在有仓库的地址时添加 WAR 上下文按钮。');
