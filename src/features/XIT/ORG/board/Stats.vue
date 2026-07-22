<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { OrgStats } from '@src/infrastructure/org-api/board';
import type { TaskStatus } from '@src/infrastructure/org-api/types';
import * as boardApi from '@src/infrastructure/org-api/board';

const stats = ref<OrgStats | null>(null);
const error = ref('');

// 按生命周期进度固定显示顺序；缺失值显示 0。
const STATUS_ORDER: TaskStatus[] = [
  'PUBLISHED',
  'AWAITING_CONTRACT',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  PUBLISHED: '已发布',
  AWAITING_CONTRACT: '待合同',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

const orderedTaskStatus = computed(() => {
  const byStatus = stats.value?.tasksByStatus ?? {};
  return STATUS_ORDER.map(status => ({
    status,
    label: STATUS_LABELS[status],
    count: byStatus[status] ?? 0,
  }));
});

async function load() {
  try {
    stats.value = await boardApi.fetchStats();
  } catch (err) {
    error.value = String(err);
  }
}
onMounted(load);
</script>
<template>
  <div>
    <div v-if="error" :class="$style.error">{{ error }}</div>
    <div v-else-if="stats">
      <div
        >组织成员：{{ stats.userCount - stats.nonOrgUserCount }}（董事会 {{ stats.boardCount }} /
        合作者 {{ stats.collaboratorCount }}）</div
      >
      <div>在线非组织用户：{{ stats.nonOrgUserCount }}</div>
      <div>任务总数：{{ stats.taskCount }}</div>
      <h4>按状态分布</h4>
      <ul>
        <li v-for="item in orderedTaskStatus" :key="item.status">
          {{ item.label }}（{{ item.status }}）: {{ item.count }}
        </li>
      </ul>
    </div>
    <div v-else>加载中...</div>
  </div>
</template>

<style module>
.error {
  color: var(--text-negative);
}
</style>
