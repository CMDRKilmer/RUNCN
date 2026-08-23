<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { userData } from '@src/store/user-data';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import NumberInput from '@src/components/forms/NumberInput.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
  getLocationLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { comparePlanets } from '@src/core/game-lookups';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';

const emit = defineEmits<{ (e: 'close'): void }>();

const days = ref(userData.settings.burn.resupply);
const name = ref(`基地补给 ${days.value}天`);
const planets = computed(() =>
  (sitesStore.all.value ?? [])
    .map(x => getEntityNameFromAddress(x.address))
    .filter(x => x !== undefined)
    .sort(comparePlanets),
);
const planet = ref(planets.value[0]);

const cxes = computed(
  () =>
    warehousesStore.all.value
      ?.filter(x => getLocationLineFromAddress(x.address)?.type === 'STATION')
      .map(x => ({
        label: getEntityNameFromAddress(x.address)!,
        value: getEntityNaturalIdFromAddress(x.address)!,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)) ?? [],
);
const cx = ref(cxes.value[0].value);

function onCreateClick() {
  if (name.value.length === 0) {
    return;
  }
  const warehouse = warehousesStore.getByEntityNaturalId(cx.value);
  const storage = storagesStore.getById(warehouse!.storeId)!;
  const cxTicker = ExchangeTickers[cx.value];
  userData.actionPackages.push({
    global: { name: name.value },
    groups: [
      {
        name: '补给',
        type: 'Resupply',
        planet: planet.value,
        days: days.value,
        useBaseInv: true,
      },
    ],
    actions: [
      {
        name: '购买缺少的材料',
        type: 'CX Buy',
        group: '补给',
        exchange: cxTicker,
        useCXInv: true,
      },
      {
        name: '在下方"To"字段中选择你的飞船 ↓',
        type: 'MTRA',
        group: '补给',
        origin: serializeStorage(storage),
        dest: configurableValue,
      },
    ],
  });
  showBuffer('XIT ACT_' + name.value.split(' ').join('_'));
  emit('close');
}

const ExchangeTickers = {
  ANT: 'AI1',
  BEN: 'CI1',
  MOR: 'NC1',
  HRT: 'IC1',
  HUB: 'NC2',
  ARC: 'CI2',
};
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>快速开始</SectionHeader>
    <div :class="$style.description">
      此预填操作包将为你的基地补充指定天数的材料。
      <br />
      创建的操作包将包含两个操作：从 CX 购买缺少的材料，然后将它们转移到配置的（下一步）飞船上。
      <br />
      点击“创建”后，你将被引导到操作包运行器。到达后，先配置目标飞船，然后按“执行”并持续按“执行步骤”直到完成。
      <br />
      <mark>注意：你需要一艘停泊在选定 CX 的飞船才能使用此功能。</mark>
    </div>
    <form>
      <Active label="名称">
        <TextInput v-model="name" />
      </Active>
      <Active label="补给来源 CX">
        <SelectInput v-model="cx" :options="cxes" />
      </Active>
      <Active label="补给星球">
        <SelectInput v-model="planet" :options="planets" />
      </Active>
      <Active label="补给天数">
        <NumberInput v-model="days" />
      </Active>
      <Commands>
        <PrunButton primary @click="onCreateClick">创建</PrunButton>
      </Commands>
    </form>
  </div>
</template>

<style module>
.description {
  line-height: 13px;
  padding: 0 4px;
  background-color: #26353e;
  margin-bottom: 5px;
}
</style>
