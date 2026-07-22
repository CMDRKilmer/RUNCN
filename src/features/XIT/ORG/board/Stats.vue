<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { OrgStats } from '@src/infrastructure/org-api/board';
import * as boardApi from '@src/infrastructure/org-api/board';

const stats = ref<OrgStats | null>(null);
const error = ref('');

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
        <li v-for="(count, status) in stats.tasksByStatus" :key="status">
          {{ status }}: {{ count }}
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
