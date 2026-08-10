<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import ExchangeSelector from '@src/components/forms/ExchangeSelector.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { cogcsStore } from '@src/infrastructure/prun-api/data/cogcs';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { userData } from '@src/store/user-data';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0 } from '@src/utils/format';
import { persistedRef } from '@src/utils/persisted-ref';

const { planet } = defineProps<{ planet?: string }>();

const exchangeStationMap: Record<string, string> = {
  AI1: 'Antares Station',
  CI1: 'Benten Station',
  IC1: 'Hortus Station',
  NC1: 'Moria Station',
  CI2: 'Arclight Station',
  NC2: 'Hubur Station',
};

const exchanges = Object.keys(exchangeStationMap);
const exchange = persistedRef('genact-cogc-exchange', exchanges[0]);
const multiplier = persistedRef('genact-cogc-multiplier', 1);

const naturalId = computed(() => planetsStore.find(planet)?.naturalId ?? planet);
const cogc = computed(() => cogcsStore.getByPlanetNaturalId(naturalId.value));

// 全额账单：所需量 = 账单 amount × 材料倍数，不扣除已贡献量
const materials = computed(() => {
  const bill = cogc.value?.upkeep?.billOfMaterial;
  if (!bill) {
    return undefined;
  }
  const m: Record<string, number> = {};
  for (const entry of bill) {
    m[entry.material.ticker] = entry.amount * multiplier.value;
  }
  return m;
});

// 数据未加载时（COGCU 工单未触发 DATA_DATA），打开 COGC 缓冲区触发加载
let dataRequested = false;
if (!cogc.value) {
  dataRequested = true;
  showBuffer(`COGC ${naturalId.value}`);
}

const warehouseName = computed(() => `${exchangeStationMap[exchange.value]} Warehouse`);
const packageName = 'SHANGHUIBUGEI';

function onGenerateClick() {
  if (!materials.value || Object.keys(materials.value).length === 0) {
    return;
  }

  const groupName = 'Supply';

  const pkg: UserData.ActionPackageData = {
    global: { name: packageName },
    groups: [
      {
        type: 'Manual',
        name: groupName,
        materials: materials.value,
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
        name: 'Transfer to Ship',
        group: groupName,
        origin: warehouseName.value,
        dest: configurableValue,
      },
    ],
  };

  const existing = userData.actionPackages.find(x => x.global.name === packageName);
  if (existing) {
    const index = userData.actionPackages.indexOf(existing);
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }

  showBuffer(`XIT ACT_${packageName.split(' ').join('_')}`);
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>生成补给 ACT 包</SectionHeader>
    <form>
      <Active label="星球">
        <span>{{ naturalId }}</span>
      </Active>

      <Active label="交易所">
        <ExchangeSelector v-model="exchange" :options="exchanges" />
      </Active>
      <Active label="仓库">
        <span>{{ warehouseName }}</span>
      </Active>
      <Active label="材料倍数">
        <NumberInput v-model="multiplier" :min="0" />
        <span>倍（默认 1 倍）</span>
      </Active>

      <Active v-if="!materials" label="材料">
        <span>正在加载账单数据{{ dataRequested ? '（已请求 COGC 数据）' : '' }}...</span>
      </Active>
      <Active v-else label="材料">
        <span v-for="(amount, ticker) in materials" :key="ticker">
          {{ ticker }}: {{ fixed0(amount) }}
        </span>
      </Active>

      <Commands>
        <PrunButton primary :disabled="!materials || multiplier <= 0" @click="onGenerateClick">
          生成
        </PrunButton>
      </Commands>
    </form>
  </div>
</template>
