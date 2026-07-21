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
import SectionHeader from '@src/components/SectionHeader.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';

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
  <!--
    整体走 PrUn panel 风格：背景/边框/标题用 C.Panel 类，标题用 SectionHeader，
    按钮全部 PrunButton，输入框走 forms/Active。
  -->
  <div :class="[C.Panel.panel, C.fonts.fontRegular, $style.detail]">
    <div :class="$style.header">
      <PrunButton dark inline @click="emit('close')">← 返回</PrunButton>
      <span :class="$style.status">{{ localTask.status }}</span>
    </div>

    <SectionHeader>基本信息</SectionHeader>
    <div :class="$style.kv">
      <div><span :class="$style.key">类型</span>{{ localTask.type }}</div>
      <div><span :class="$style.key">名称</span>{{ localTask.contractJson.name || '—' }}</div>
      <div><span :class="$style.key">货币</span>{{ localTask.contractJson.currency }}</div>
      <div v-if="localTask.contractJson.location">
        <span :class="$style.key">位置</span>{{ localTask.contractJson.location }}
      </div>
      <div v-if="localTask.contractJson.origin || localTask.contractJson.destination">
        <span :class="$style.key">路径</span>{{ localTask.contractJson.origin }} →
        {{ localTask.contractJson.destination }}
      </div>
      <div v-if="localTask.contractJson.price !== undefined">
        <span :class="$style.key">总价</span>
        {{
          formatAmountWithCurrency(localTask.contractJson.price, localTask.contractJson.currency)
        }}
      </div>
      <div v-if="localTask.contractJson.deadline !== undefined">
        <span :class="$style.key">期限</span>
        {{ formatNumber(localTask.contractJson.deadline) }} 天
      </div>
      <div>
        <span :class="$style.key">发布者</span>
        {{ localTask.publisherUsername }} ({{ localTask.publisherCompanyCode }})
      </div>
      <div v-if="localTask.claimerUsername">
        <span :class="$style.key">接取者</span>
        {{ localTask.claimerUsername }} ({{ localTask.claimerCompanyCode }})
      </div>
      <div v-if="localTask.contractId">
        <span :class="$style.key">关联合同</span>{{ localTask.contractId }}
      </div>
      <div v-if="localTask.expiresAt">
        <span :class="$style.key">有效期</span>
        {{ new Date(localTask.expiresAt).toLocaleString() }}
      </div>
    </div>

    <SectionHeader>物品清单</SectionHeader>
    <ul :class="$style.items">
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

    <section v-if="error" :class="$style.error">{{ error }}</section>

    <!-- ActionBar 自带容器间距与分隔；PrunButton 自动套上主题。 -->
    <ActionBar>
      <PrunButton v-if="canClaim" primary :disabled="loading" @click="onClaim">接取任务</PrunButton>
      <PrunButton v-if="canRelease" primary :disabled="loading" @click="onRelease"
        >释放任务</PrunButton
      >
      <PrunButton v-if="canCreateContract" dark @click="onCreateContract"
        >创建合同（CONTGEN → CONTD）</PrunButton
      >
      <PrunButton v-if="canCreateContract" dark @click="emit('link-contract')"
        >上报合同 ID</PrunButton
      >
      <PrunButton v-if="canShowCancelButton" neutral :disabled="loading" @click="onCancel">
        取消任务
      </PrunButton>
      <PrunButton
        v-if="showBoardCancelButton && !showBoardCancel && canShowCancelButton"
        dark
        :disabled="loading"
        @click="showBoardCancel = true">
        董事会取消此任务
      </PrunButton>
      <PrunButton
        v-if="canDelete && !showDeleteConfirm"
        danger
        :disabled="loading"
        @click="showDeleteConfirm = true">
        删除任务
      </PrunButton>
    </ActionBar>

    <template v-if="showBoardCancel">
      <Active label="董事会取消原因（必填）">
        <TextInput v-model="boardCancelReason" />
      </Active>
      <ActionBar>
        <PrunButton danger :disabled="loading || !boardCancelReason" @click="onCancel"
          >确认取消</PrunButton
        >
        <PrunButton neutral @click="showBoardCancel = false">放弃</PrunButton>
      </ActionBar>
    </template>

    <template v-if="showDeleteConfirm">
      <Active label="删除二次确认（输入 DELETE）">
        <TextInput v-model="deleteConfirmText" />
      </Active>
      <ActionBar>
        <PrunButton danger :disabled="loading || deleteConfirmText !== 'DELETE'" @click="onDelete">
          确认删除
        </PrunButton>
        <PrunButton
          neutral
          @click="
            showDeleteConfirm = false;
            deleteConfirmText = '';
          ">
          放弃
        </PrunButton>
      </ActionBar>
    </template>

    <SectionHeader>备注</SectionHeader>
    <NoteEditor :task-id="localTask.id" :notes="notes" @changed="onNotesChanged" />
  </div>
</template>

<style module>
.detail {
  padding: 8px 12px 12px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.status {
  font-size: 12px;
  color: var(--text-muted);
}
/* KV 行：左对齐 key + value，模拟 PrUn 面板里的 key-value 列表样式 */
.kv > div {
  display: flex;
  gap: 12px;
  padding: 2px 0;
  font-size: 13px;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}
.key {
  flex: 0 0 80px;
  color: var(--text-muted);
  text-align: right;
}
.items {
  margin: 4px 0 12px;
  padding-left: 18px;
  font-size: 13px;
}
.items li {
  margin-bottom: 2px;
}
.error {
  padding: 8px;
  color: var(--text-negative);
  background: var(--panel-background-alt);
  margin: 8px 0;
}
</style>
