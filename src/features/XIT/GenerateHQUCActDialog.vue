<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { calculateHQUpgradeMaterials } from '@src/core/hq';
import { userData } from '@src/store/user-data';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { withOptionalRareExchanges } from '@src/core/exchange-options';

const { from, to } = defineProps<{ from: number; to: number }>();

const exchangeStationMap: Record<string, string> = {
  AI1: 'Antares Station',
  CI1: 'Benten Station',
  IC1: 'Hortus Station',
  NC1: 'Moria Station',
  CI2: 'Arclight Station',
  NC2: 'Hubur Station',
};

const exchanges = computed(() => withOptionalRareExchanges(Object.keys(exchangeStationMap)));
const exchange = ref(exchanges.value[0]);

const warehouseName = computed(() => `${exchangeStationMap[exchange.value]} Warehouse`);
const packageName = 'ZONGBUSHENJI';

function onGenerateClick() {
  const materialAmounts = calculateHQUpgradeMaterials(from, to);

  const materials: Record<string, number> = {};
  for (const { material, amount } of materialAmounts) {
    if (amount > 0) {
      materials[material.ticker] = amount;
    }
  }

  if (Object.keys(materials).length === 0) {
    return;
  }

  const groupName = 'HQ Upgrade';
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
        name: 'Transfer to HQ',
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
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>生成升级 ACT 包</SectionHeader>
    <form>
      <Active label="升级范围">
        <span>{{ from }} → {{ to }}</span>
      </Active>
      <Active label="交易所">
        <SelectInput v-model="exchange" :options="exchanges" />
      </Active>
      <Active label="仓库">
        <span>{{ warehouseName }}</span>
      </Active>
      <Commands>
        <PrunButton primary @click="onGenerateClick">生成</PrunButton>
      </Commands>
    </form>
  </div>
</template>
