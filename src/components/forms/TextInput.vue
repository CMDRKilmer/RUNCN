<script setup lang="ts">
const model = defineModel<string>();

const {
  focusOnMount = false,
  list,
  type = 'text',
} = defineProps<{
  focusOnMount?: boolean;
  list?: string;
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
      :list="list"
      autocomplete="off"
      data-1p-ignore="true"
      data-lpignore="true" />
  </div>
</template>
