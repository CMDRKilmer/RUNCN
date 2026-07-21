<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { OrgUser } from '@src/infrastructure/org-api/types';
import * as boardApi from '@src/infrastructure/org-api/board';
import { canPromoteDemote } from '@src/infrastructure/org-api/permissions';
import { HttpError } from '@src/infrastructure/org-api/client';

defineProps<{ currentUser: OrgUser }>();
const users = ref<OrgUser[]>([]);
const error = ref('');

async function load() {
  try {
    users.value = await boardApi.listUsers();
  } catch (err) {
    error.value = String(err);
  }
}

async function onPromote(userId: string) {
  if (!confirm('确定提升为董事会？')) {
    return;
  }
  try {
    await boardApi.promoteUser(userId);
    await load();
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  }
}

async function onDemote(userId: string) {
  if (!confirm('确定降级为合作者？')) {
    return;
  }
  try {
    await boardApi.demoteUser(userId);
    await load();
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h3>用户管理</h3>
    <div v-if="error" :class="$style.error">{{ error }}</div>
    <table :class="$style.table">
      <thead>
        <tr><th>显示名</th><th>PrUn 用户名</th><th>公司代码</th><th>角色</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.displayName }}</td>
          <td>{{ u.prunUsername }}</td>
          <td>{{ u.companyCode }}</td>
          <td>{{ u.role === 'BOARD' ? '董事会' : '合作者' }}</td>
          <td>
            <template v-if="canPromoteDemote(currentUser, u.id)">
              <button v-if="u.role !== 'BOARD'" @click="onPromote(u.id)">提升</button>
              <button v-else @click="onDemote(u.id)">降级</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style module>
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.table th,
.table td {
  border: 1px solid var(--panel-border);
  padding: 4px 8px;
  text-align: left;
}
.error {
  color: var(--text-negative);
  padding: 8px;
}
</style>
