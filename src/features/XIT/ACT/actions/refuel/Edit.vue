<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { serializeStorage, storageSort } from '@src/features/XIT/ACT/actions/utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import RadioItem from '@src/components/forms/RadioItem.vue';
import { getRefuelOrigins } from '@src/features/XIT/ACT/actions/refuel/utils';

const { action } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

const storages = computed(() => {
  const storages = getRefuelOrigins().sort(storageSort).map(serializeStorage);
  storages.unshift(configurableValue);
  return storages;
});

const origin = ref(action.origin ?? storages.value[0]);

const buyMissingFuel = ref(action.buyMissingFuel ?? true);

function validate() {
  return true;
}

function save() {
  action.origin = origin.value;
  action.buyMissingFuel = buyMissingFuel.value;
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="来源">
    <SelectInput v-model="origin" :options="storages" />
  </Active>
  <Active label="购买缺少的燃料" tooltip="如果库存不足，是否购买燃料（仅交易所仓库）。">
    <RadioItem v-model="buyMissingFuel">购买燃料</RadioItem>
  </Active>
</template>
