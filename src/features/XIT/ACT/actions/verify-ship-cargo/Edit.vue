<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';

const { action } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

const registration = ref(action.registration ?? '');
const tickers = ref(Object.keys(action.verifyRemaining ?? {}).join('、'));

function validate() {
  return registration.value.length > 0;
}

function save() {
  action.registration = registration.value;
  // 顿号/逗号/空白分隔的物资代码；每个期望剩余 ≤ 0（货舱须清空该物资）。
  const list = tickers.value
    .split(/[\s,，、]+/)
    .map(x => x.trim().toUpperCase())
    .filter(x => x.length > 0);
  action.verifyRemaining = list.length > 0 ? Object.fromEntries(list.map(x => [x, 0])) : undefined;
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="飞船注册号" tooltip="校验该飞船货舱是否已清空指定物资。">
    <TextInput v-model="registration" />
  </Active>
  <Active
    label="物资"
    tooltip="顿号/逗号分隔的物资代码（如 RAT、DW）；留空则仅校验货舱可读。每个物资期望剩余 ≤ 0。">
    <TextInput v-model="tickers" />
  </Active>
</template>
