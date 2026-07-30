<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userData } from '@src/store/user-data';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

const { planetNaturalId } = defineProps<{ planetNaturalId?: string }>();

const site = computed(() => sitesStore.getByPlanetNaturalId(planetNaturalId));

const exchangeStationMap: Record<string, string> = {
  AI1: 'Antares Station',
  CI1: 'Benten Station',
  IC1: 'Hortus Station',
  NC1: 'Moria Station',
  CI2: 'Arclight Station',
  NC2: 'Hubur Station',
};

const exchanges = Object.keys(exchangeStationMap);
const exchange = ref(exchanges[0]);
const useBaseInv = ref(true);
const timeOffset = ref<'now' | '24' | '48'>('now');

const warehouseName = computed(() => `${exchangeStationMap[exchange.value]} Warehouse`);
const packageName = 'JIANZHUWEIXIU';

const repairMaterialsKey = computed<'repairMaterials' | 'repairMaterials24' | 'repairMaterials48'>(
  () =>
    timeOffset.value === '24'
      ? 'repairMaterials24'
      : timeOffset.value === '48'
        ? 'repairMaterials48'
        : 'repairMaterials',
);

function onGenerateClick() {
  if (!site.value) {
    return;
  }

  const baseInventory: Record<string, number> = {};
  if (useBaseInv.value) {
    const baseStore = storagesStore.all.value?.find(
      x => x.addressableId === site.value!.siteId && x.type === 'STORE',
    );
    if (baseStore) {
      for (const item of baseStore.items) {
        if (item.quantity) {
          baseInventory[item.quantity.material.ticker] = item.quantity.amount;
        }
      }
    }
  }

  const materials: Record<string, number> = {};
  for (const platform of site.value.platforms) {
    const repairMaterials = platform[repairMaterialsKey.value] ?? [];
    for (const { material, amount } of repairMaterials) {
      materials[material.ticker] = (materials[material.ticker] ?? 0) + amount;
    }
  }

  if (useBaseInv.value) {
    for (const ticker of Object.keys(materials)) {
      const inBase = baseInventory[ticker] ?? 0;
      const need = Math.max(0, materials[ticker] - inBase);
      if (need > 0) {
        materials[ticker] = need;
      } else {
        delete materials[ticker];
      }
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
      {
        type: 'MTRA',
        name: 'Transfer to Base',
        group: groupName,
        origin: warehouseName.value,
        dest: configurableValue,
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

  showBuffer(`XIT ACT_${name}`);
}
</script>

<template>
  <div v-if="!site" :class="C.DraftConditionEditor.form">
    <SectionHeader>生成维修 ACT 包</SectionHeader>
    <div :class="$style.notice">未找到星球基地数据。</div>
  </div>
  <div v-else :class="C.DraftConditionEditor.form">
    <SectionHeader>生成维修 ACT 包</SectionHeader>
    <form>
      <Active label="星球">
        <span>{{ planetNaturalId }}</span>
      </Active>

      <Active label="交易所">
        <SelectInput v-model="exchange" :options="exchanges" />
      </Active>
      <Active label="仓库">
        <span>{{ warehouseName }}</span>
      </Active>
      <Active label="扣除基地库存" tooltip="扣除基地仓库中已有的材料后再计算采购量。">
        <RadioItem v-model="useBaseInv">扣除基地库存</RadioItem>
      </Active>
      <Active label="时间偏移" tooltip="对应 BRA 面板上的「现在」「+24h」「+48h」预览。">
        <SelectInput
          v-model="timeOffset"
          :options="[
            { label: '现在', value: 'now' },
            { label: '+24h', value: '24' },
            { label: '+48h', value: '48' },
          ]" />
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
