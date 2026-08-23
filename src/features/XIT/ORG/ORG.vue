<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, readonly, ref } from 'vue';
import type { AuthSession, OrgTask, OrgUser, TaskType } from '@src/infrastructure/org-api/types';
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
import { startGlobalAutoLink, stopGlobalAutoLink } from '@src/infrastructure/org-api/auto-link';
import { listTasks } from '@src/infrastructure/org-api/tasks';
import { notifyTaskClaimed } from '@src/infrastructure/org-api/task-activity';
import { useOrgTileState } from './tile-state';
import AuthOverlay from './AuthOverlay.vue';
import RoleBadge from './RoleBadge.vue';
import TaskList from './TaskList.vue';
import MarketView from './MarketView.vue';
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
  // 关键：停止全局 auto-link，避免 session 过期后持续发送 401 请求
  stopGlobalAutoLink();
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

// 任务更新事件总线（实时渲染通道）：
//   - auto-link 触发 onLinked / onStatusSynced 时调用 notifyTaskUpdated(task)
//   - polling 触发 onTaskStatusChanged 时也调用 notifyTaskUpdated(task)
//   - TaskList / TaskDetail 订阅 onTaskUpdated，自行决定是否替换本地行
// 这样"我的接取/我的发布"列表可以在 5 秒级 auto-link 节奏内看到任务状态变化。
type TaskEventListener = (task: OrgTask) => void;
const taskEventListeners: TaskEventListener[] = [];
provide('orgTaskEvents', {
  subscribe: (fn: TaskEventListener) => {
    taskEventListeners.push(fn);
    return () => {
      const idx = taskEventListeners.indexOf(fn);
      if (idx >= 0) {
        taskEventListeners.splice(idx, 1);
      }
    };
  },
});
function notifyTaskUpdated(task: OrgTask) {
  for (const fn of taskEventListeners) {
    fn(task);
  }
}

// 任务状态变化通知（架构 §12.11）
const pollCallbacks: PollCallbacks = {
  onTaskStatusChanged: (task, oldStatus, newStatus) => {
    console.info(`[ORG] Task ${task.id} status: ${oldStatus} → ${newStatus}`);
    // 实时推送到 TaskList / TaskDetail（5 秒级刷新通道）
    notifyTaskUpdated(task);
  },
  onNewTask: task => {
    console.info(`[ORG] New task: ${task.id}`);
    notifyTaskUpdated(task);
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
    // auto-link 现在按需：接取任务（listings.claimListing）成功后才注册到活跃集合，
    // globalTick interval 才会起来。面板 mount 时不再无脑起。
    // 这里仍调一次 startGlobalAutoLink 以初始化 callbacks 占位。
    // 5 秒级自动 link / sync 触发时通过 callbacks 转发到 taskEvents 总线，
    // TaskList 订阅后即时更新列表行（替代原本只靠 30s polling）。
    startGlobalAutoLink({
      onLinked: task => notifyTaskUpdated(task),
      onStatusSynced: task => notifyTaskUpdated(task),
    });
    // 恢复扫描：把刷新前已在进行中的任务重新拉回活跃集合，
    // 否则 module-level 单例的 activeLinkedTaskIds 是空的，interval 不会起。
    void recoverActiveTasks();
  } else {
    showAuth.value = true;
  }
});

onBeforeUnmount(() => {
  stopPolling();
  // 关闭全局 auto-link 轮询并清理所有 session。
  stopGlobalAutoLink();
});

function onAuthenticated(newSession: AuthSession) {
  session.value = newSession;
  showAuth.value = false;
  resetPollingState();
  setCurrentUser(newSession.user);
  startPolling(pollCallbacks);
  // 登入后初始化 auto-link callbacks；interval 仍按活跃任务数量按需启停。
  // 同样注册 onLinked / onStatusSynced，让 TaskList 即时看到 link / sync 结果。
  startGlobalAutoLink({
    onLinked: task => notifyTaskUpdated(task),
    onStatusSynced: task => notifyTaskUpdated(task),
  });
  // 恢复扫描：与 mount 时相同，登入后把已有进行中的任务注册到活跃集合。
  void recoverActiveTasks();
}

async function onLogout() {
  await authApi.logout();
  session.value = null;
  showAuth.value = true;
  resetPollingState();
  // 登出后停止全局 auto-link，避免下一用户登入前残留状态。
  stopGlobalAutoLink();
}

// 恢复扫描：刷新页面 / 重新登录后，活跃任务集合（模块级单例）是空的。
// 拉一次 claimed + published 列表，把仍在 AWAITING_CONTRACT / IN_PROGRESS
// 且我作为 claimer 或 publisher 的任务重新注册到活跃集合，让 globalTick
// 起来继续做合同自动关联 + sync contract status。
async function recoverActiveTasks(): Promise<void> {
  try {
    const [claimed, published] = await Promise.all([
      listTasks({ scope: 'claimed', limit: 100 }),
      listTasks({ scope: 'published', limit: 100 }),
    ]);
    const seen = new Set<string>();
    for (const task of [...claimed.items, ...published.items]) {
      if (seen.has(task.id)) {
        continue;
      }
      seen.add(task.id);
      notifyTaskClaimed(task);
    }
  } catch (err) {
    console.warn('[ORG] recoverActiveTasks failed:', err);
  }
}

const tabs = computed(() => {
  const list: Array<{
    key: 'market' | 'shipping' | 'published' | 'claimed' | 'board-admin';
    label: string;
  }> = [
    { key: 'market', label: '市场' },
    { key: 'shipping', label: '运输' },
    { key: 'published', label: '我的发布' },
    { key: 'claimed', label: '我的接取' },
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
  /* Anchor for TradeOverlay / LinkOverlay: they use position:absolute and
     must be constrained to this ORG window, not escape to the viewport. */
  position: relative;
  min-height: 0;
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
  /* Ensure child overlays (TradeOverlay / LinkContract) clip to this area
     even if a future ancestor loses its positioning. */
  position: relative;
  min-height: 0;
}
</style>
