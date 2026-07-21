<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ContractCreator, OrgTask, OrgUser } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import { HttpError } from '@src/infrastructure/org-api/client';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';

const props = defineProps<{ task: OrgTask; currentUser: OrgUser }>();
const emit = defineEmits<{
  (e: 'linked', task: OrgTask): void;
  (e: 'cancel'): void;
}>();

const contractId = ref('');
const creator = ref<ContractCreator>(
  props.task.publisherId === props.currentUser.id ? 'publisher' : 'claimer',
);
const error = ref('');
const loading = ref(false);

// 候选合同：从 contractsStore 中拉取最近的合同供用户选择
const candidateContracts = computed(() => {
  const all = contractsStore.all.value ?? [];
  // 显示最近 20 个，按 id 倒序
  return [...all].slice(0, 20);
});

const canSubmit = computed(() => contractId.value.length > 0 && !loading.value);

async function onSubmit() {
  if (!canSubmit.value) {
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const updated = await tasksApi.linkContract(props.task.id, {
      contractId: contractId.value,
      contractCreator: creator.value,
    });
    emit('linked', updated);
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div :class="$style.overlay">
    <div :class="$style.card">
      <h3>上报合同 ID</h3>
      <div :class="$style.form">
        <label>
          合同 ID
          <input v-model="contractId" placeholder="如 KS8F2H..." list="candidate-contracts" />
          <datalist id="candidate-contracts">
            <option v-for="c in candidateContracts" :key="c.id" :value="c.id" />
          </datalist>
        </label>
        <label>
          合同创建方
          <select v-model="creator">
            <option value="publisher">发布者创建</option>
            <option value="claimer">接取者创建</option>
          </select>
        </label>
        <div v-if="error" :class="$style.error">{{ error }}</div>
        <div :class="$style.actions">
          <button :disabled="!canSubmit" @click="onSubmit">
            {{ loading ? '提交中...' : '上报' }}
          </button>
          <button @click="emit('cancel')">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style module>
.overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.card {
  background: var(--panel-background);
  border: 1px solid var(--panel-border);
  padding: 16px;
  width: 360px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}
.form label {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  gap: 4px;
}
.form input,
.form select {
  padding: 6px 8px;
  border: 1px solid var(--panel-border);
  background: var(--input-background);
  color: var(--text);
}
.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.actions button {
  padding: 6px 12px;
  border: 1px solid var(--panel-border);
  background: var(--panel-background-alt);
  color: var(--text);
  cursor: pointer;
}
.actions button:first-child {
  background: var(--accent);
  color: var(--text-on-accent);
  border-color: var(--accent);
}
.actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  color: var(--text-negative);
  font-size: 12px;
}
</style>
