<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const { action } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

const planet = ref(action.planet ?? '');
const planetError = ref(false);

function validate() {
  planetError.value = planet.value.trim().length === 0;
  return !planetError.value;
}

function save() {
  action.planet = planet.value.trim();
}

defineExpose({ validate, save });
</script>

<template>
  <Active :label="getI18nValue('RP.ACT.fields.planet', 'Planet')" :error="planetError">
    <TextInput
      v-model="planet"
      :placeholder="getI18nValue('RP.ACT.actions.govburnData.placeholder', 'Natural ID or name')" />
  </Active>
</template>
