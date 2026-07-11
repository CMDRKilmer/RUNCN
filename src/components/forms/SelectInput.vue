<script setup lang="ts">
const model = defineModel<string>();

type Option =
  | string
  | {
      label: string;
      value: string;
    };

withDefaults(defineProps<{ options: Option[]; width?: number | string }>(), { width: 158 });

const value = (option: Option) => (typeof option === 'string' ? option : option.value);
const label = (option: Option) => (typeof option === 'string' ? option : option.label);
</script>

<template>
  <div
    :class="$style.container"
    :style="{ width: typeof width === 'number' ? `${width}px` : width }">
    <select v-model="model" :class="$style.select">
      <option v-for="option in options" :key="value(option)" :value="value(option)">
        {{ label(option) }}
      </option>
    </select>
  </div>
</template>

<style module>
.container {
  margin-right: 0;
  margin-left: auto;
}

.select {
  width: 100%;
}
</style>
