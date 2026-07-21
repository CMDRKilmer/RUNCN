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
  <!--
    PrUn 没有官方 C.Chip.* 类（项目里唯一 chip 风格的地方是 StatusFilter 的 statusChip，但语义不同），
    所以这里只走项目自身的 CSS module：双层渐变模拟 PrUn 金属/合金质感。
    BOARD 用暖金色 chip；COLLABORATOR 用冷灰 chip。
  -->
  <span
    v-if="user"
    :class="[
      C.fonts.fontRegular,
      C.type.typeSmall,
      $style.chip,
      user.role === 'BOARD' ? $style.board : $style.collaborator,
    ]">
    {{ label }}
  </span>
</template>

<style module>
.chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.4);
  font-weight: 600;
  text-shadow: 0 -1px 0 rgba(0, 0, 0, 0.5);
}
.board {
  background: linear-gradient(180deg, #c8893a 0%, #8a5a1d 50%, #6e4717 100%);
  color: #fff3d4;
}
.collaborator {
  background: linear-gradient(180deg, #424d5a 0%, #2c333d 50%, #1d2229 100%);
  color: #c8c8c8;
}
</style>
