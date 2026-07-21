<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AuthSession, OrgUser } from '@src/infrastructure/org-api/types';
import { getStoredSession, setOnUnauthorizedCallback } from '@src/infrastructure/org-api/client';
import * as authApi from '@src/infrastructure/org-api/auth';
import {
  resetPollingState,
  setCurrentUser,
  startPolling,
  stopPolling,
  type PollCallbacks,
} from '@src/infrastructure/org-api/polling';
import { canSeeBoardPanel } from '@src/infrastructure/org-api/permissions';
import { useOrgTileState } from './tile-state';
import AuthOverlay from './AuthOverlay.vue';
import RoleBadge from './RoleBadge.vue';
import TaskList from './TaskList.vue';
import PublishTask from './PublishTask.vue';
import BoardPanel from './board/BoardPanel.vue';

const session = ref<AuthSession | null>(getStoredSession());
const currentUser = computed<OrgUser | null>(() => session.value?.user ?? null);
const tab = useOrgTileState('tab');

// 触发 AuthOverlay 显示（401 时）
const showAuth = ref(false);
setOnUnauthorizedCallback(() => {
  session.value = null;
  showAuth.value = true;
  resetPollingState();
});

// 任务状态变化通知（架构 §12.11）
const pollCallbacks: PollCallbacks = {
  onTaskStatusChanged: (task, oldStatus, newStatus) => {
    console.info(`[ORG] Task ${task.id} status: ${oldStatus} → ${newStatus}`);
    // TODO: 接入 PrUn NOTS 通知（架构 §7.3 双通道通知）
    // 暂用 console + 面板内 Badge（TaskList 内通过轮询刷新自动反映）
  },
  onNewTask: task => {
    console.info(`[ORG] New task: ${task.id}`);
  },
  onRoleChanged: (oldRole, newRole) => {
    console.info(`[ORG] Role changed: ${oldRole} → ${newRole}`);
    // role 变化时刷新 /auth/me 同步本地 user
    void authApi.fetchMe().then(user => {
      if (session.value) {
        session.value = { ...session.value, user };
      }
    });
  },
  onError: err => {
    console.warn('[ORG] Polling error:', err);
  },
};

onMounted(() => {
  if (session.value) {
    setCurrentUser(session.value.user);
    startPolling(pollCallbacks);
  } else {
    showAuth.value = true;
  }
});

onBeforeUnmount(() => {
  stopPolling();
});

function onAuthenticated(newSession: AuthSession) {
  session.value = newSession;
  showAuth.value = false;
  resetPollingState();
  setCurrentUser(newSession.user);
  startPolling(pollCallbacks);
}

async function onLogout() {
  await authApi.logout();
  session.value = null;
  showAuth.value = true;
  resetPollingState();
}

const tabs = computed(() => {
  const list: Array<{
    key: 'board' | 'published' | 'claimed' | 'publish' | 'board-admin';
    label: string;
  }> = [
    { key: 'board', label: '任务板' },
    { key: 'published', label: '我的发布' },
    { key: 'claimed', label: '我的接取' },
    { key: 'publish', label: '发布任务' },
  ];
  if (canSeeBoardPanel(currentUser.value)) {
    list.push({ key: 'board-admin', label: '管理' });
  }
  return list;
});
</script>

<template>
  <div :class="$style.container">
    <AuthOverlay v-if="showAuth" @authenticated="onAuthenticated" />
    <template v-else-if="session">
      <header :class="$style.header">
        <span :class="$style.user">{{ session.user.displayName }}</span>
        <RoleBadge :user="session.user" />
        <button :class="$style.logout" @click="onLogout">登出</button>
      </header>
      <nav :class="$style.tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          :class="[$style.tab, tab === t.key && $style.active]"
          @click="tab = t.key">
          {{ t.label }}
        </button>
      </nav>
      <main :class="$style.content">
        <TaskList
          v-if="tab === 'board' || tab === 'published' || tab === 'claimed'"
          :scope="tab"
          :current-user="session.user" />
        <PublishTask v-else-if="tab === 'publish'" />
        <BoardPanel v-else-if="tab === 'board-admin'" :current-user="session.user" />
      </main>
    </template>
  </div>
</template>

<style module>
.container {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px;
}
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--panel-border);
}
.user {
  font-weight: 600;
}
.logout {
  margin-left: auto;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--panel-border);
  color: var(--text-muted);
  cursor: pointer;
}
.tabs {
  display: flex;
  gap: 4px;
  padding: 8px 0;
  border-bottom: 1px solid var(--panel-border);
}
.tab {
  padding: 4px 12px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.tab.active {
  color: var(--text);
  border-color: var(--panel-border);
  background: var(--panel-background-alt);
}
.content {
  flex: 1;
  overflow: auto;
  padding-top: 8px;
}
</style>
