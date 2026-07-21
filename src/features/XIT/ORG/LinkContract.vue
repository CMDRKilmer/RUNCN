<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ContractCreator, OrgTask, OrgUser } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import { HttpError } from '@src/infrastructure/org-api/client';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import SectionHeader from '@src/components/SectionHeader.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';

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
    <div :class="[C.Panel.panel, C.fonts.fontRegular, $style.card]">
      <SectionHeader>上报合同 ID</SectionHeader>
      <div :class="$style.form">
        <Active label="合同 ID">
          <TextInput v-model="contractId" />
        </Active>
        <Active label="合同创建方">
          <SelectInput
            v-model="creator"
            :options="[
              { value: 'publisher', label: '发布者创建' },
              { value: 'claimer', label: '接取者创建' },
            ]" />
        </Active>
        <div v-if="error" :class="$style.error">{{ error }}</div>
        <ActionBar>
          <PrunButton primary :disabled="!canSubmit" @click="onSubmit">
            {{ loading ? '提交中...' : '上报' }}
          </PrunButton>
          <PrunButton neutral @click="emit('cancel')">取消</PrunButton>
        </ActionBar>
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
  padding: 12px 16px 16px;
  width: 380px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.error {
  color: var(--text-negative);
  font-size: 12px;
  padding: 2px 0;
}
</style>
