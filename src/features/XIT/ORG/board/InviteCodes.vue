<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { InviteCode } from '@src/infrastructure/org-api/types';
import * as boardApi from '@src/infrastructure/org-api/board';
import { HttpError } from '@src/infrastructure/org-api/client';

const codes = ref<InviteCode[]>([]);
const error = ref('');
const newCount = ref(5);
const generating = ref(false);

async function load() {
  try {
    codes.value = await boardApi.listInviteCodes();
  } catch (err) {
    error.value = String(err);
  }
}

async function onGenerate() {
  if (generating.value || newCount.value <= 0) {
    return;
  }
  generating.value = true;
  error.value = '';
  try {
    await boardApi.generateInviteCodes({ count: newCount.value, createdBy: 'board-ui' });
    await load();
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    generating.value = false;
  }
}

async function onRevoke(id: string) {
  if (!confirm('确定吊销此未使用的邀请码？')) {
    return;
  }
  try {
    await boardApi.revokeInviteCode(id);
    await load();
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h3>邀请码管理</h3>
    <div :class="$style.generate">
      <input v-model.number="newCount" type="number" min="1" max="50" />
      <button :disabled="generating" @click="onGenerate">
        {{ generating ? '生成中...' : '生成邀请码' }}
      </button>
    </div>
    <div v-if="error" :class="$style.error">{{ error }}</div>
    <table :class="$style.table">
      <thead>
        <tr><th>邀请码</th><th>创建者</th><th>状态</th><th>使用人</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="c in codes" :key="c.id">
          <td
            ><code>{{ c.code }}</code></td
          >
          <td>{{ c.createdBy }}</td>
          <td>
            <span v-if="c.revokedAt">已吊销</span>
            <span v-else-if="c.usedByUserId">已使用</span>
            <span v-else>未使用</span>
          </td>
          <td>{{ c.usedByUserId ?? '—' }}</td>
          <td>
            <button v-if="!c.usedByUserId && !c.revokedAt" @click="onRevoke(c.id)">吊销</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style module>
.generate {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.generate input {
  width: 80px;
  padding: 4px;
  border: 1px solid var(--panel-border);
  background: var(--input-background);
  color: var(--text);
}
.generate button {
  padding: 4px 12px;
  border: 1px solid var(--panel-border);
  background: var(--accent);
  color: var(--text-on-accent);
  cursor: pointer;
}
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
