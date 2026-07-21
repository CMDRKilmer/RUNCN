<script setup lang="ts">
import { ref } from 'vue';
import type { OrgUser } from '@src/infrastructure/org-api/types';
import InviteCodes from './InviteCodes.vue';
import UserManager from './UserManager.vue';
import AuditLogs from './AuditLogs.vue';
import Stats from './Stats.vue';

defineProps<{ currentUser: OrgUser }>();

type Section = 'stats' | 'invite-codes' | 'users' | 'audit-logs';
const section = ref<Section>('stats');

const sections: Array<{ key: Section; label: string }> = [
  { key: 'stats', label: '统计' },
  { key: 'invite-codes', label: '邀请码' },
  { key: 'users', label: '用户' },
  { key: 'audit-logs', label: '审计' },
];
</script>

<template>
  <div :class="$style.panel">
    <nav :class="$style.nav">
      <button
        v-for="s in sections"
        :key="s.key"
        :class="[$style.navItem, section === s.key && $style.active]"
        @click="section = s.key">
        {{ s.label }}
      </button>
    </nav>
    <div :class="$style.body">
      <Stats v-if="section === 'stats'" />
      <InviteCodes v-else-if="section === 'invite-codes'" />
      <UserManager v-else-if="section === 'users'" :current-user="currentUser" />
      <AuditLogs v-else-if="section === 'audit-logs'" />
    </div>
  </div>
</template>

<style module>
.panel {
  display: flex;
  height: 100%;
}
.nav {
  display: flex;
  flex-direction: column;
  width: 120px;
  padding: 8px 0;
  border-right: 1px solid var(--panel-border);
}
.navItem {
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
}
.navItem.active {
  color: var(--text);
  background: var(--panel-background-alt);
  border-left: 2px solid var(--accent);
}
.body {
  flex: 1;
  padding: 12px;
  overflow: auto;
}
</style>
