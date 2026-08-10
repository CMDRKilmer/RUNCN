<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import ExchangeSelector from '@src/components/forms/ExchangeSelector.vue';
import Commands from '@src/components/forms/Commands.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userData } from '@src/store/user-data';
import { persistedRef } from '@src/utils/persisted-ref';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

const { registration } = defineProps<{ registration?: string }>();

const ship = computed(() => shipsStore.getByRegistration(registration));

const exchangeStationMap: Record<string, string> = {
  AI1: 'Antares Station',
  CI1: 'Benten Station',
  IC1: 'Hortus Station',
  NC1: 'Moria Station',
  CI2: 'Arclight Station',
  NC2: 'Hubur Station',
};

const exchanges = Object.keys(exchangeStationMap);
const exchange = persistedRef('genact-ship-exchange', exchanges[0]);
const useShipInv = persistedRef('genact-ship-use-inv', true);

const warehouseName = computed(() => `${exchangeStationMap[exchange.value]} Warehouse`);
const packageName = 'FEICHUANWEIXIU';

function onGenerateClick() {
  if (!ship.value) {
    return;
  }

  const shipInventory: Record<string, number> = {};
  if (useShipInv.value) {
    const shipStore = storagesStore.getById(ship.value.idShipStore);
    if (shipStore) {
      for (const item of shipStore.items) {
        if (item.quantity) {
          shipInventory[item.quantity.material.ticker] = item.quantity.amount;
        }
      }
    }
  }

  const materials: Record<string, number> = {};
  for (const { material, amount } of ship.value.repairMaterials) {
    const inShip = shipInventory[material.ticker] ?? 0;
    const need = Math.max(0, amount - inShip);
    if (need > 0) {
      materials[material.ticker] = need;
    }
  }

  const groupName = 'Repair';
  const name = packageName;

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
        name: 'CX Buy',
        group: groupName,
        exchange: exchange.value,
        buyPartial: false,
        allowUnfilled: false,
        useCXInv: true,
      },
    ],
  };

  const existing = userData.actionPackages.find(x => x.global.name === name);
  if (existing) {
    const index = userData.actionPackages.indexOf(existing);
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }

  showBuffer(`XIT ACT_${name.split(' ').join('_')}`);
}
</script>

<template>
  <div v-if="!ship" :class="C.DraftConditionEditor.form">
    <SectionHeader>生成维修 ACT 包</SectionHeader>
    <div :class="$style.notice">未找到飞船数据。</div>
  </div>
  <div v-else :class="C.DraftConditionEditor.form">
    <SectionHeader>生成维修 ACT 包</SectionHeader>
    <form>
      <Active label="飞船">
        <span>{{ ship.name }}</span>
      </Active>

      <Active label="交易所">
        <ExchangeSelector v-model="exchange" :options="exchanges" />
      </Active>
      <Active label="仓库">
        <span>{{ warehouseName }}</span>
      </Active>
      <Active label="扣除飞船库存" tooltip="扣除飞船货舱中已有的材料后再计算采购量。">
        <RadioItem v-model="useShipInv">扣除飞船库存</RadioItem>
      </Active>
      <Commands>
        <PrunButton primary @click="onGenerateClick">生成</PrunButton>
      </Commands>
    </form>
  </div>
</template>

<style module>
.notice {
  padding: 8px 4px;
  color: rgb(217, 83, 79);
}
</style>
