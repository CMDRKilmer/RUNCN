<script setup lang="ts">
const { optional } = defineProps<{ optional?: boolean }>();

const model = defineModel<number | undefined>();

const inputModel = computed({
  get: () => model.value,
  set: (value: string) => {
    if (value !== '') {
      const num = parseFloat(value);
      if (!isNaN(num) && isFinite(num)) {
        model.value = num;
      } else {
        model.value = 0;
      }
      return;
    }
    if (optional) {
      model.value = undefined;
      return;
    }

    model.value = 0;
  },
});
</script>

<template>
  <div>
    <input
      v-model="inputModel"
      type="number"
      autocomplete="off"
      data-1p-ignore="true"
      data-lpignore="true" />
  </div>
</template>
