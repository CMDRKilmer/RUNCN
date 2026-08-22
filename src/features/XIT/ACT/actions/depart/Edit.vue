<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';

const { action } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

const registration = ref(action.registration ?? '');

function validate() {
  return registration.value.length > 0;
}

function save() {
  action.registration = registration.value;
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="飞船注册号" tooltip="自动点击该飞船航行控制面板中的「开始」按钮发船。">
    <TextInput v-model="registration" />
  </Active>
</template>
