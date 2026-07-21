<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { AuditLog } from '@src/infrastructure/org-api/types';
import * as boardApi from '@src/infrastructure/org-api/board';

const logs = ref<AuditLog[]>([]);
const error = ref('');

async function load() {
  try {
    const result = await boardApi.listAuditLogs({ limit: 100 });
    logs.value = result.items;
  } catch (err) {
    error.value = String(err);
  }
}
onMounted(load);
</script>

<template>
  <div>
    <h3>审计日志</h3>
    <div v-if="error" :class="$style.error">{{ error }}</div>
    <table :class="$style.table">
      <thead>
        <tr><th>时间</th><th>动作</th><th>操作方</th><th>目标</th><th>元数据</th></tr>
      </thead>
      <tbody>
        <tr v-for="l in logs" :key="l.id">
          <td>{{ new Date(l.createdAt).toLocaleString() }}</td>
          <td
            ><code>{{ l.action }}</code></td
          >
          <td>{{ l.actorType }}{{ l.actorId ? `: ${l.actorId.slice(0, 8)}` : '' }}</td>
          <td>{{ l.targetType ? `${l.targetType}#${l.targetId?.slice(0, 8)}` : '—' }}</td>
          <td
            ><code>{{ l.metadata ? JSON.stringify(l.metadata) : '' }}</code></td
          >
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style module>
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.table th,
.table td {
  border: 1px solid var(--panel-border);
  padding: 3px 6px;
  text-align: left;
}
.error {
  color: var(--text-negative);
  padding: 8px;
}
</style>
