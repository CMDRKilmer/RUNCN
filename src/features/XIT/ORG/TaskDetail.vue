<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue';
import type { OrgTask, OrgUser, TaskNote } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import * as notesApi from '@src/infrastructure/org-api/notes';
import { HttpError } from '@src/infrastructure/org-api/client';
import {
  canCancelTask,
  canDeleteTask,
  shouldShowBoardCancel,
} from '@src/infrastructure/org-api/permissions';
import {
  watchContractStatus,
  clearReportedStatus,
} from '@src/infrastructure/org-api/contract-link';
import { sendTaskToContd, formatAmountWithCurrency, formatNumber } from './utils';
import NoteEditor from './NoteEditor.vue';

const props = defineProps<{ task: OrgTask; currentUser: OrgUser }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'updated', task: OrgTask): void;
  (e: 'link-contract'): void;
  (e: 'deleted', task: OrgTask): void;
}>();

const localTask = ref<OrgTask>(props.task);
const notes = ref<TaskNote[]>([]);
const loading = ref(false);
const error = ref('');
const boardCancelReason = ref('');
const showBoardCancel = ref(false);
// 删除二次确认：输入 "DELETE" 才允许点击"确认删除"，避免误点。
const showDeleteConfirm = ref(false);
const deleteConfirmText = ref('');

watch(
  () => props.task,
  t => {
    localTask.value = t;
  },
);

// 监听合同状态变化（架构 §7.3）
watchEffect(() => {
  watchContractStatus(localTask.value);
});

onBeforeUnmount(() => {
  clearReportedStatus(localTask.value.id);
});

async function loadNotes() {
  try {
    notes.value = await notesApi.listNotes(localTask.value.id);
  } catch (err) {
    console.warn('[ORG] loadNotes failed:', err);
  }
}

void loadNotes();

watch(
  () => localTask.value.id,
  () => {
    void loadNotes();
  },
);

const isPublisher = computed(() => localTask.value.publisherId === props.currentUser.id);
const isClaimer = computed(() => localTask.value.claimerId === props.currentUser.id);
const isParticipant = computed(() => isPublisher.value || isClaimer.value);

const canClaim = computed(() => localTask.value.status === 'PUBLISHED' && !isPublisher.value);
const canRelease = computed(
  () => localTask.value.status === 'AWAITING_CONTRACT' && isClaimer.value,
);
const canCancel = computed(() => canCancelTask(props.currentUser, localTask.value));
// 仅在 status 不是 terminal（CANCELLED / COMPLETED）时显示"取消任务"按钮：
// terminal 状态下取消语义不明，改用"删除任务"。
const canShowCancelButton = computed(
  () =>
    canCancel.value &&
    localTask.value.status !== 'CANCELLED' &&
    localTask.value.status !== 'COMPLETED',
);
// CANCELLED / COMPLETED 状态下：仅发布者可物理删除。后端拒错由 store/error 提示。
const canDelete = computed(() => canDeleteTask(props.currentUser, localTask.value));
const canCreateContract = computed(
  () =>
    localTask.value.status === 'AWAITING_CONTRACT' &&
    !localTask.value.contractId &&
    isParticipant.value,
);
const showBoardCancelButton = computed(() =>
  shouldShowBoardCancel(props.currentUser, localTask.value),
);

async function updateTask(op: () => Promise<OrgTask>) {
  loading.value = true;
  error.value = '';
  try {
    const updated = await op();
    localTask.value = updated;
    emit('updated', updated);
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function onClaim() {
  await updateTask(() => tasksApi.claimTask(localTask.value.id));
}

async function onRelease() {
  await updateTask(() => tasksApi.releaseTask(localTask.value.id));
}

async function onCancel() {
  if (showBoardCancelButton.value && !boardCancelReason.value) {
    error.value = '董事会取消他人任务必须填写原因';
    return;
  }
  await updateTask(() =>
    tasksApi.cancelTask(
      localTask.value.id,
      showBoardCancelButton.value ? boardCancelReason.value : undefined,
    ),
  );
  showBoardCancel.value = false;
}

// 删除任务：必须输入 "DELETE" 二次确认。删除后 emit 'deleted'（含快照）
// 由 TaskList 负责从本地 tasks[] 移除并 refresh。
async function onDelete() {
  if (deleteConfirmText.value !== 'DELETE') {
    error.value = '请输入 DELETE 以确认删除';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const snapshot = await tasksApi.deleteTask(localTask.value.id);
    emit('deleted', snapshot);
    emit('close');
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
    showDeleteConfirm.value = false;
    deleteConfirmText.value = '';
  }
}

function onCreateContract() {
  // contractCreator 决定反转规则：publisher 视角不反转，claimer 视角反转
  const creatorIsPublisher =
    localTask.value.contractCreator === 'publisher' ? isPublisher.value : !isPublisher.value;
  sendTaskToContd(localTask.value.contractJson, localTask.value.type, creatorIsPublisher);
}

function onNotesChanged() {
  void loadNotes();
}
</script>

<template>
  <div :class="$style.detail">
    <header :class="$style.header">
      <button :class="$style.back" @click="emit('close')">← 返回</button>
      <span :class="$style.status">{{ localTask.status }}</span>
    </header>

    <section :class="$style.section">
      <h3>基本信息</h3>
      <div>类型：{{ localTask.type }}</div>
      <div>名称：{{ localTask.contractJson.name || '—' }}</div>
      <div>货币：{{ localTask.contractJson.currency }}</div>
      <div v-if="localTask.contractJson.location">位置：{{ localTask.contractJson.location }}</div>
      <div v-if="localTask.contractJson.origin || localTask.contractJson.destination">
        路径：{{ localTask.contractJson.origin }} → {{ localTask.contractJson.destination }}
      </div>
      <div v-if="localTask.contractJson.price !== undefined">
        总价：{{
          formatAmountWithCurrency(localTask.contractJson.price, localTask.contractJson.currency)
        }}
      </div>
      <div v-if="localTask.contractJson.deadline !== undefined">
        期限：{{ formatNumber(localTask.contractJson.deadline) }} 天
      </div>
      <div>发布者：{{ localTask.publisherUsername }} ({{ localTask.publisherCompanyCode }})</div>
      <div v-if="localTask.claimerUsername">
        接取者：{{ localTask.claimerUsername }} ({{ localTask.claimerCompanyCode }})
      </div>
      <div v-if="localTask.contractId">关联合同：{{ localTask.contractId }}</div>
      <div v-if="localTask.expiresAt"
        >有效期：{{ new Date(localTask.expiresAt).toLocaleString() }}</div
      >
    </section>

    <section :class="$style.section">
      <h3>物品清单</h3>
      <ul>
        <li v-for="(item, i) in localTask.contractJson.items" :key="i">
          {{ formatNumber(item.amount) }}× {{ item.commodity }}
          <span v-if="item.price !== undefined">
            @ {{ formatAmountWithCurrency(item.price, localTask.contractJson.currency)
            }}<span v-if="item.amount > 1">
              （共
              {{
                formatAmountWithCurrency(item.price * item.amount, localTask.contractJson.currency)
              }}）</span
            >
          </span>
        </li>
      </ul>
    </section>

    <section v-if="error" :class="$style.error">{{ error }}</section>

    <section :class="$style.actions">
      <button v-if="canClaim" :disabled="loading" @click="onClaim">接取任务</button>
      <button v-if="canRelease" :disabled="loading" @click="onRelease">释放任务</button>
      <button v-if="canCreateContract" @click="onCreateContract"
        >创建合同（CONTGEN → CONTD）</button
      >
      <button v-if="canCreateContract" @click="emit('link-contract')">上报合同 ID</button>
      <!--
        "取消任务" 仅在非 terminal 状态显示（CANCELLED/COMPLETED 用删除替代）
      -->
      <button v-if="canShowCancelButton" :disabled="loading" @click="onCancel"> 取消任务 </button>
      <button
        v-if="showBoardCancelButton && !showBoardCancel && canShowCancelButton"
        :disabled="loading"
        @click="showBoardCancel = true">
        董事会取消此任务
      </button>
      <template v-if="showBoardCancel">
        <input v-model="boardCancelReason" placeholder="取消原因（必填）" />
        <button :disabled="loading" @click="onCancel">确认取消</button>
        <button @click="showBoardCancel = false">放弃</button>
      </template>
      <!--
        "删除任务" 仅发布者自己可见。CANCELLED/COMPLETED 状态清理冗余
        任务用。二次确认输入 "DELETE" 才生效。
      -->
      <button
        v-if="canDelete && !showDeleteConfirm"
        :disabled="loading"
        :class="$style.danger"
        @click="showDeleteConfirm = true">
        删除任务
      </button>
      <template v-if="showDeleteConfirm">
        <input
          v-model="deleteConfirmText"
          placeholder="输入 DELETE 以确认"
          :class="$style.dangerInput" />
        <button
          :disabled="loading || deleteConfirmText !== 'DELETE'"
          :class="$style.danger"
          @click="onDelete">
          确认删除
        </button>
        <button
          @click="
            showDeleteConfirm = false;
            deleteConfirmText = '';
          ">
          放弃
        </button>
      </template>
    </section>

    <section :class="$style.section">
      <h3>备注</h3>
      <NoteEditor :task-id="localTask.id" :notes="notes" @changed="onNotesChanged" />
    </section>
  </div>
</template>

<style module>
.detail {
  padding: 12px;
  border: 1px solid var(--panel-border);
  background: var(--panel-background);
}
.header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}
.back {
  background: transparent;
  border: 1px solid var(--panel-border);
  color: var(--text-muted);
  padding: 4px 8px;
  cursor: pointer;
}
.status {
  font-size: 12px;
  color: var(--text-muted);
}
.section {
  margin-bottom: 16px;
  font-size: 13px;
}
.section h3 {
  font-size: 13px;
  margin: 0 0 6px;
  color: var(--text);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 0;
  border-top: 1px solid var(--panel-border);
  border-bottom: 1px solid var(--panel-border);
}
.actions button {
  padding: 6px 12px;
  border: 1px solid var(--panel-border);
  background: var(--panel-background-alt);
  color: var(--text);
  cursor: pointer;
}
.actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.actions input {
  flex: 1;
  min-width: 200px;
  padding: 6px 8px;
  border: 1px solid var(--panel-border);
  background: var(--input-background);
  color: var(--text);
}
/* 删除相关危险样式：红色边框 + 悬停加深。disabled 灰禁。 */
.danger {
  border-color: var(--text-negative, #d9534f) !important;
  color: var(--text-negative, #d9534f);
}
.danger:hover:not(:disabled) {
  background: var(--text-negative, #d9534f) !important;
  color: var(--text-on-accent, #fff);
}
.dangerInput {
  border-color: var(--text-negative, #d9534f) !important;
}
.error {
  padding: 8px;
  color: var(--text-negative);
  background: var(--panel-background-alt);
  margin-bottom: 12px;
}
</style>
