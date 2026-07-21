<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <div :class="[C.fonts.fontRegular, C.type.typeRegular, $style.empty]">{{ message }}</div>
</template>

<style module>
.empty {
  padding: 24px 32px;
  text-align: center;
  color: var(--text-muted);
  border: 1px dashed var(--panel-border);
  background: var(--panel-background-alt);
}
</style>
