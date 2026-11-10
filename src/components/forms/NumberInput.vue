<script setup lang="ts">
const { max, min, optional, integer } = defineProps<{
  max?: number;
  min?: number;
  optional?: boolean;
  integer?: boolean;
}>();

const model = defineModel<number | undefined>();

const inputModel = computed({
  get: () => model.value,
  set: (value: string) => {
    if (integer) {
      return;
    }
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

function commitIntegerInput(event: Event) {
  if (!integer) {
    return;
  }
  const input = event.target as HTMLInputElement;
  const value = input.value.trim();
  const num = Number(value);
  if (value === '' && optional) {
    model.value = undefined;
    input.value = '';
    return;
  }
  if (
    value !== '' &&
    Number.isSafeInteger(num) &&
    num >= (min ?? -Infinity) &&
    num <= (max ?? Infinity)
  ) {
    model.value = num;
    input.value = String(num);
    return;
  }
  input.value = String(model.value ?? '');
}
</script>

<template>
  <div>
    <input
      v-model="inputModel"
      type="text"
      :inputmode="integer ? 'numeric' : 'decimal'"
      :min="min"
      :max="max"
      autocomplete="off"
      data-1p-ignore="true"
      data-lpignore="true"
      @change="commitIntegerInput"
      @keyup.enter="commitIntegerInput" />
  </div>
</template>
