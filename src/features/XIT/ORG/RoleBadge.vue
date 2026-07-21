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
    :class="[$style.badge, user.role === 'BOARD' ? $style.board : $style.collaborator]">
    {{ label }}
  </span>
</template>

<style module>
.badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 2px;
  border: 1px solid var(--panel-border);
}
.board {
  background: var(--accent);
  color: var(--text-on-accent);
  border-color: var(--accent);
}
.collaborator {
  color: var(--text-muted);
}
</style>
