<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { OrgTask, OrgUser, PollScope } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import TaskCard from './TaskCard.vue';
import TaskDetail from './TaskDetail.vue';
import EmptyState from './EmptyState.vue';

const props = defineProps<{
  scope: PollScope;
  currentUser: OrgUser;
}>();

const tasks = ref<OrgTask[]>([]);
const loading = ref(false);
const error = ref('');
const selectedTask = ref<OrgTask | null>(null);

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
watch(() => props.scope, refresh);

// 简单刷新：外部可通过轮询间接刷新；详情页关闭后重新拉取
function onDetailClosed() {
  selectedTask.value = null;
  void refresh();
}

onBeforeUnmount(() => {
  selectedTask.value = null;
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
      @close="onDetailClosed" />
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
