<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import SelectInput from '@src/components/forms/SelectInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import { comparePlanets } from '@src/core/game-lookups';
import TextInput from '@src/components/forms/TextInput.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';

const { group } = defineProps<{ group: UserData.MaterialGroupData }>();

const planets = computed(() => {
  const planets = (sitesStore.all.value ?? [])
    .map(x => getEntityNameFromAddress(x.address))
    .filter(x => x !== undefined)
    .sort(comparePlanets);
  planets.unshift(configurableValue);
  return planets;
});

const planet = ref(group.planet ?? planets.value[0]);
const planetError = ref(false);

const days = ref(
  typeof group.days === 'string' ? parseInt(group.days || '10') : (group.days ?? 10),
);
const daysError = ref(false);

const exclusions = ref(group.exclusions?.join(', ') ?? '');

const useBaseInventory = ref(group.useBaseInv ?? true);

const workforceOnly = ref(group.consumablesOnly ?? false);

function validate() {
  let isValid = true;
  planetError.value = !planet.value;
  isValid &&= !planetError.value;
  daysError.value = days.value <= 0;
  isValid &&= !daysError.value;
  return isValid;
}

function save() {
  group.planet = planet.value;
  group.days = days.value;
  group.exclusions = exclusions.value
    .split(',')
    .map(x => materialsStore.getByTicker(x.trim())?.ticker)
    .filter(x => x !== undefined);
  group.useBaseInv = useBaseInventory.value;
  group.consumablesOnly = workforceOnly.value;
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="星球" :error="planetError">
    <SelectInput v-model="planet" :options="planets" />
  </Active>
  <Active label="天数" tooltip="补充该星球所需的供应天数。" :error="daysError">
    <NumberInput v-model="days" />
  </Active>
  <Active label="材料排除" tooltip="要从组中排除的材料。用逗号分隔材料代码。">
    <TextInput v-model="exclusions" />
  </Active>
  <Active label="使用基地库存" tooltip="计算总量时是否将基地中现有材料计入。">
    <RadioItem v-model="useBaseInventory">使用基地库存</RadioItem>
  </Active>
  <Active label="仅劳动力" tooltip="是否将材料组限制为仅包含劳动力消耗品。">
    <RadioItem v-model="workforceOnly">仅劳动力</RadioItem>
  </Active>
</template>
