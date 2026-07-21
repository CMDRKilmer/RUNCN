<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <div :class="$style.empty">{{ message }}</div>
</template>

<style module>
.empty {
  padding: 32px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
