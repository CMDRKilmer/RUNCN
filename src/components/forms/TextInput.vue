<script setup lang="ts">
const model = defineModel<string>();

const { focusOnMount = false, type = 'text' } = defineProps<{
  focusOnMount?: boolean;
  type?: string;
}>();

const input = useTemplateRef<HTMLInputElement>('input');

onMounted(() => {
  if (focusOnMount) {
    nextTick(() => input.value?.focus());
  }
});
</script>

<template>
  <div>
    <input
      ref="input"
      v-model="model"
      :type="type"
      autocomplete="off"
      data-1p-ignore="true"
      data-lpignore="true" />
  </div>
</template>
