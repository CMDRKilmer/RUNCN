<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { OrgTask, OrgUser, PollScope } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import TaskCard from './TaskCard.vue';
import TaskDetail from './TaskDetail.vue';
import LinkContract from './LinkContract.vue';
import EmptyState from './EmptyState.vue';

const props = defineProps<{
  scope: PollScope;
  currentUser: OrgUser;
}>();

const tasks = ref<OrgTask[]>([]);
const loading = ref(false);
const error = ref('');
const selectedTask = ref<OrgTask | null>(null);
// LinkContract 是 fixed overlay（z-index:1000），TaskDetail 也是 fixed overlay（z-index:1100）。
// 必须放在 TaskDetail 外，独立成兄弟层；层级靠 z-index 区分（LinkContract 略低）。
const showLinkContract = ref(false);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const result = await tasksApi.listTasks({ scope: props.scope, limit: 100 });
    tasks.value = result.items;
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
// scope 切换时（同 ORG pane 内 board/published/claimed 互切）清除详情与子弹窗，
// 防止旧 scope 的 TaskDetail 留在新列表下方。
// 注意：LinkContract 内嵌在 TaskList 模板里，selectedTask=null 之后它的 v-if 已会收起。
watch(
  () => props.scope,
  () => {
    selectedTask.value = null;
    showLinkContract.value = false;
    void refresh();
  },
);

// 详情更新后同步到本地列表（拉取最新 task 后再用 returned 对象替换）
function onTaskUpdated(updated: OrgTask) {
  selectedTask.value = updated;
  const idx = tasks.value.findIndex(t => t.id === updated.id);
  if (idx >= 0) {
    tasks.value.splice(idx, 1, updated);
  }
}

// 简单刷新：外部可通过轮询间接刷新；详情页关闭后重新拉取
function onDetailClosed() {
  selectedTask.value = null;
  showLinkContract.value = false;
  void refresh();
}

// 详情页要求打开 LinkContract 时转发事件（TaskDetail 不直接持有 LinkContract）
function onRequestLinkContract() {
  if (selectedTask.value) {
    showLinkContract.value = true;
  }
}

async function onContractLinked(updated: OrgTask) {
  selectedTask.value = updated;
  showLinkContract.value = false;
  const idx = tasks.value.findIndex(t => t.id === updated.id);
  if (idx >= 0) {
    tasks.value.splice(idx, 1, updated);
  }
  void refresh();
}

onBeforeUnmount(() => {
  selectedTask.value = null;
  showLinkContract.value = false;
});
</script>

<template>
  <div :class="$style.list">
    <div v-if="loading" :class="$style.info">加载中...</div>
    <div v-else-if="error" :class="$style.error">{{ error }}</div>
    <template v-else-if="tasks.length === 0">
      <EmptyState message="暂无任务" />
    </template>
    <template v-else>
      <template v-for="task in tasks" :key="task?.id">
        <TaskCard
          v-if="task"
          :task="task"
          :current-user="currentUser"
          @click="selectedTask = task" />
      </template>
    </template>

    <TaskDetail
      v-if="selectedTask"
      :task="selectedTask"
      :current-user="currentUser"
      @close="onDetailClosed"
      @updated="onTaskUpdated"
      @link-contract="onRequestLinkContract" />
    <LinkContract
      v-if="showLinkContract && selectedTask"
      :task="selectedTask"
      :current-user="currentUser"
      @linked="onContractLinked"
      @cancel="showLinkContract = false" />
  </div>
</template>

<style module>
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}
.info {
  padding: 16px;
  color: var(--text-muted);
  text-align: center;
}
.error {
  padding: 16px;
  color: var(--text-negative);
  text-align: center;
}
</style>
