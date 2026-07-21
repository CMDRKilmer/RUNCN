<script setup lang="ts">
import type { OrgUser } from '@src/infrastructure/org-api/types';
import { computed } from 'vue';

const props = defineProps<{ user: OrgUser | null }>();

const label = computed(() => {
  if (!props.user) {
    return '';
  }
  return props.user.role === 'BOARD' ? '董事会' : '合作者';
});
</script>

<template>
  <span
    v-if="user"
    :class="[
      C.Chip.chip,
      C.fonts.fontRegular,
      C.type.typeSmall,
      user.role === 'BOARD' ? $style.board : $style.collaborator,
    ]">
    {{ label }}
  </span>
</template>

<style module>
/* PrUn 风格 chip：双层渐变模拟 PrUn 金属/合金质感。BOARD 用暖金色，COLLABORATOR 用冷灰。 */
.board {
  background: linear-gradient(180deg, #a36d1e, #6e4a17);
  color: #f6e5b6;
}
.collaborator {
  background: linear-gradient(180deg, #2c333d, #1d2229);
  color: #b3b3b3;
}
</style>
