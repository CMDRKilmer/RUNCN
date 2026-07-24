<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, readonly, ref } from 'vue';
import type { AuthSession, OrgUser, TaskType } from '@src/infrastructure/org-api/types';
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
import MarketView from './MarketView.vue';
import PublishTask from './PublishTask.vue';
import BoardPanel from './board/BoardPanel.vue';
import Header from '@src/components/Header.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';

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

// MarketView → PublishTask 的预填桥接：MarketView 把数据写入下面这个 ref，
// PublishTask 通过 inject('orgMarketPrefill') 拿到同一 ref 并消费一次后清空。
// provide 默认是 readonly 的，这里通过 readonly 包裹避免子组件误写。
const pendingPublishPrefill = ref<{
  type: Extract<TaskType, 'BUY' | 'SELL' | 'SHIP'>;
  ticker?: string;
  amount?: number;
  price?: number;
  currency?: string;
  location?: string;
  contractName?: string;
} | null>(null);
// 提供两个 key：ref 本身（只读）+ 写入回调（受控）。MarketView 用回调写，PublishTask 用 ref 读。
provide('orgMarketPrefill', readonly(pendingPublishPrefill));
provide('orgMarketPrefillSet', (data: typeof pendingPublishPrefill.value) => {
  pendingPublishPrefill.value = data;
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
  // 用户在线上报已迁移到 main.ts 的扩展启动阶段（reportExtensionUserOnStartup），
  // 这里只负责会话/轮询初始化。
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
    key: 'market' | 'shipping' | 'published' | 'claimed' | 'publish' | 'board-admin';
    label: string;
  }> = [
    { key: 'market', label: '市场' },
    { key: 'shipping', label: '运输' },
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
      <!--
        顶部条：PrUn 官方 Header（大字体）+ RoleBadge chip + 登出按钮。
        ActionBar 让按钮自动带上容器间距。整体观感与 XIT 其它面板一致。
      -->
      <div :class="$style.topBar">
        <Header>{{ session.user.displayName }}</Header>
        <RoleBadge :user="session.user" />
        <ActionBar>
          <PrunButton dark inline @click="onLogout">登出</PrunButton>
        </ActionBar>
      </div>

      <!--
        Tabs 用 PrUn 自带 .toggleIndicator 阴影样式，避免再写一份手工 tab。
      -->
      <div :class="C.Tabs.tabs">
        <div v-for="t in tabs" :key="t.key" :class="C.Tabs.header" @click="tab = t.key">
          <template v-if="tab === t.key">
            <a :class="[C.Tabs.tabActive, C.Tabs.tab, C.fonts.fontRegular, C.type.typeRegular]">
              {{ t.label }}
            </a>
            <div
              :class="[
                C.Tabs.toggleIndicator,
                C.Tabs.toggleIndicatorActive,
                C.effects.shadowPrimary,
              ]" />
          </template>
          <template v-else>
            <a :class="[C.Tabs.tab, C.fonts.fontRegular, C.type.typeRegular]">{{ t.label }}</a>
            <div :class="[C.Tabs.toggleIndicator]" />
          </template>
        </div>
      </div>

      <main :class="$style.content">
        <MarketView v-if="tab === 'market'" />
        <TaskList
          v-else-if="tab === 'shipping' || tab === 'published' || tab === 'claimed'"
          :scope="tab"
          :current-user="session.user" />
        <PublishTask
          v-else-if="tab === 'publish'"
          :initial-data="pendingPublishPrefill ?? undefined"
          @consumed="() => (pendingPublishPrefill = null)" />
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
.topBar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
}
.content {
  flex: 1;
  overflow: auto;
  padding-top: 8px;
}
</style>
