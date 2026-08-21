<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { userData } from '@src/store/user-data';

const { action } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

const bases = computed(() =>
  (sitesStore.all.value ?? []).map(x => getEntityNaturalIdFromAddress(x.address)!),
);

const base = ref(action.base ?? bases.value[0] ?? '');
const threshold = ref(action.threshold ?? userData.settings.repair.threshold);

function validate() {
  return base.value.length > 0 && threshold.value > 0 && threshold.value <= 100;
}

function save() {
  action.base = base.value;
  action.threshold = threshold.value;
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="基地" tooltip="执行维修的基地（打开该基地的建筑维护助手）。">
    <SelectInput v-model="base" :options="bases" />
  </Active>
  <Active label="状况阈值" tooltip="仅勾选状况低于该百分比的建筑提交维修。">
    <NumberInput v-model="threshold" :min="1" :max="100" />
    <span>%</span>
  </Active>
</template>
