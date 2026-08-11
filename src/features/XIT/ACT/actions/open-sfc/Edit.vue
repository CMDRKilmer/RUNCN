<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';

const { action } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

const destination = ref(action.destination ?? '');

function validate() {
  return destination.value.length > 0;
}

function save() {
  action.destination = destination.value;
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="目的地星球" tooltip="打开航行控制后填入的目的地（自然 ID 或名称）。">
    <TextInput v-model="destination" />
  </Active>
  <Active label="飞船来源">
    <span>{{ action.shipSourceAction ?? '未指定' }}</span>
  </Active>
</template>
