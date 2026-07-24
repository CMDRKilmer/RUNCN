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
import {
  startAutoLink,
  stopAutoLink,
  isAutoLinkRunning,
  type AutoLinkMatch,
} from '@src/infrastructure/org-api/auto-link';
import { sendTaskToContd, formatAmountWithCurrency, formatNumber, statusLabel } from './utils';
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

// 自动关联合同状态（ORG 任务接取后默认开启自动关联）。
// canAutoLink=true → 自动调 startAutoLink；用户可手动关闭（停止轮询）。
const autoLinkRunning = ref(isAutoLinkRunning(props.task.id));
const pendingMatch = ref<AutoLinkMatch | null>(null);
const confirmCountdown = ref(0);
// onMatch 返回的 Promise resolver：用户点确认/取消时调用
let pendingResolve: ((v: boolean) => void) | null = null;
let confirmTimer: ReturnType<typeof setInterval> | null = null;

watch(
  () => props.task,
  t => {
    localTask.value = t;
  },
);

// 自动关联 watch 块：必须在 canAutoLink 声明之后才注册（避免 TDZ），
// 见下方 canAutoLink 声明后的同段代码。

// 监听合同状态变化（架构 §7.3）
watchEffect(() => {
  watchContractStatus(localTask.value);
});

onBeforeUnmount(() => {
  clearReportedStatus(localTask.value.id);
  stopAutoLink(localTask.value.id);
  if (confirmTimer) clearInterval(confirmTimer);
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
// 释放按钮可见条件：
//   - 完整接取任务：状态 AWAITING_CONTRACT 且我是 claimer
//   - 部分接取子任务：状态 AWAITING_CONTRACT 且我是 publisher（接取者持有反向合同）
//   - 都不能在已签反向合同后（IN_PROGRESS / COMPLETED）释放
const canRelease = computed(
  () =>
    localTask.value.status === 'AWAITING_CONTRACT' &&
    (isClaimer.value ||
      (localTask.value.publisherId === props.currentUser.id &&
        localTask.value.parentTaskId !== undefined)),
);
const canCancel = computed(() => canCancelTask(props.currentUser, localTask.value));
// 仅在 status 不是 terminal（CANCELLED / COMPLETED）时显示"取消任务"按钮：
// terminal 状态下取消语义不明，改用"删除任务"。
// partial claim 子任务不能取消（后端 CANNOT_CANCEL_CHILD_TASK）；
// 这里用 parentTaskId 提前隐藏，避免发起无效请求。
const canShowCancelButton = computed(
  () =>
    canCancel.value &&
    localTask.value.status !== 'CANCELLED' &&
    localTask.value.status !== 'COMPLETED' &&
    localTask.value.parentTaskId === undefined,
);
// 重新发布：仅 publisher 自己可把 CANCELLED 状态的任务转回 PUBLISHED。
const canRepublish = computed(() => localTask.value.status === 'CANCELLED' && isPublisher.value);
// CANCELLED / COMPLETED 状态下：仅发布者可物理删除。后端拒错由 store/error 提示。
// partial claim 子任务不能删除（后端 CANNOT_DELETE_CHILD_TASK）；同样隐藏按钮。
const canDelete = computed(
  () =>
    canDeleteTask(props.currentUser, localTask.value) && localTask.value.parentTaskId === undefined,
);
const canCreateContract = computed(
  () =>
    localTask.value.status === 'AWAITING_CONTRACT' &&
    !localTask.value.contractId &&
    isParticipant.value,
);
// 自动关联：仅在 AWAITING_CONTRACT + 参与者 + 未关联合同 时可用
const canAutoLink = computed(
  () =>
    localTask.value.status === 'AWAITING_CONTRACT' &&
    !localTask.value.contractId &&
    isParticipant.value,
);

function startConfirmCountdown() {
  confirmCountdown.value = 5;
  if (confirmTimer) clearInterval(confirmTimer);
  confirmTimer = setInterval(() => {
    confirmCountdown.value -= 1;
    if (confirmCountdown.value <= 0) {
      if (confirmTimer) clearInterval(confirmTimer);
      confirmTimer = null;
      onConfirmAutoLink();
    }
  }, 1000);
}

function onStartAutoLink() {
  startAutoLink(localTask.value, {
    onStateChange: state => {
      autoLinkRunning.value = state === 'running';
    },
    onMatch: match => {
      pendingMatch.value = match;
      startConfirmCountdown();
      return new Promise<boolean>(resolve => {
        pendingResolve = resolve;
      });
    },
    onLinked: updated => {
      localTask.value = updated;
      emit('updated', updated);
      pendingMatch.value = null;
      pendingResolve = null;
    },
    onError: err => {
      error.value = err.message;
    },
  });
}

// 自动关联默认开启：canAutoLink 首次为 true 且尚未运行时启动一次。
// 任务切到 IN_PROGRESS/COMPLETED/CANCELLED 后由 auto-link 内部停止，
// 这里只补一次手动 onCreateContract 后未点自动关联按钮的入口。
// 注册顺序：必须在 canAutoLink 声明之后 + onStartAutoLink 函数声明之后，
// 否则 setup 阶段 immediate=true 会触发 TDZ（参见历史上 "Cannot access
// 'canAutoLink' before initialization" 错误）。
watch(
  canAutoLink,
  ok => {
    if (!ok) return;
    if (isAutoLinkRunning(localTask.value.id)) return;
    onStartAutoLink();
  },
  { immediate: true },
);

function onStopAutoLink() {
  stopAutoLink(localTask.value.id);
  autoLinkRunning.value = false;
}

function onConfirmAutoLink() {
  if (confirmTimer) clearInterval(confirmTimer);
  confirmTimer = null;
  pendingMatch.value = null;
  pendingResolve?.(true);
  pendingResolve = null;
}

function onCancelAutoLink() {
  if (confirmTimer) clearInterval(confirmTimer);
  confirmTimer = null;
  pendingMatch.value = null;
  pendingResolve?.(false);
  pendingResolve = null;
}
const showBoardCancelButton = computed(() =>
  shouldShowBoardCancel(props.currentUser, localTask.value),
);

// updateTask 接收任意带 .task 的返回值结构：
//   - OrgTask（旧 API：patchTask / cancelTask / republishTask 等直接返 task）
//   - ReleaseTaskResult（releaseTask 新版：{ task, parentTaskId?, restoredAmount? }）
//   - ClaimTaskResult（claimTask：{ task, childTask? }）
// 我们统一从结果里抽 .task 字段更新本地视图。
async function updateTask(op: () => Promise<{ task: OrgTask } | OrgTask>) {
  loading.value = true;
  error.value = '';
  try {
    const result = await op();
    const updated: OrgTask = 'task' in result ? result.task : result;
    localTask.value = updated;
    emit('updated', updated);
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function onClaim() {
  const result = await tasksApi.claimTask(localTask.value.id);
  // 完整接取：localTask = 原任务（已经 claimer_id 变化）
  // 部分接取：localTask = parent（用户视角下他操作的就是原任务）
  localTask.value = result.task;
  emit('updated', result.task);
  if (result.childTask) {
    // 部分接取：通知上层可以切到子任务查看 AWAITING_CONTRACT 详情
    emit('updated', result.task);
  }
}

async function onRelease() {
  const result = await tasksApi.releaseTask(localTask.value.id);
  // 完整接取：localTask 已是原任务（AWAITING_CONTRACT → PUBLISHED）
  // 部分接取子任务 release：result.task 是父任务（amount 已加回）
  localTask.value = result.task;
  emit('updated', result.task);
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

async function onRepublish() {
  if (!confirm('确认重新发布此任务？将清空接取信息，合同关联也会被释放。')) {
    return;
  }
  await updateTask(() => tasksApi.republishTask(localTask.value.id));
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

async function onCreateContract() {
  // contractCreator 决定反转规则：publisher 视角不反转，claimer 视角反转
  const creatorIsPublisher = localTask.value.contractCreator === 'publisher';
  // Mirror the try/catch shape of the other handlers above so a
  // failure in the auto-fill helper (e.g. timed-out store update)
  // surfaces in the same error banner as the rest of the panel.
  loading.value = true;
  error.value = '';
  try {
    await sendTaskToContd(localTask.value.contractJson, localTask.value.type, creatorIsPublisher);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
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
  <div :class="[C.DraftConditionEditor.form, C.fonts.fontRegular, $style.detail]">
    <div :class="$style.header">
      <PrunButton dark inline @click="emit('close')">← 返回</PrunButton>
      <span :class="$style.status">{{ statusLabel(localTask.status, localTask.contractId) }}</span>
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
        <!--
          字段语义对齐 PrUn CONTGEN：SHIP 下 contractJson.price 即"运费"，
          BUY/SELL 下 contractJson.price 是顶层"总价"（每行无单价时的 fallback）。
        -->
        <span :class="$style.key">{{ localTask.type === 'SHIP' ? '运费' : '总价' }}</span>
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
      <PrunButton v-if="canCreateContract" dark :disabled="loading" @click="onCreateContract"
        >创建合同（CONTGEN → CONTD）</PrunButton
      >
      <PrunButton v-if="canCreateContract" dark @click="emit('link-contract')"
        >上报合同 ID</PrunButton
      >
      <PrunButton v-if="autoLinkRunning" dark :disabled="loading" @click="onStopAutoLink">
        🤖 关闭自动关联
      </PrunButton>
      <PrunButton v-if="canShowCancelButton" neutral :disabled="loading" @click="onCancel">
        取消任务
      </PrunButton>
      <PrunButton v-if="canRepublish" primary :disabled="loading" @click="onRepublish">
        重新发布
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

    <!--
      自动关联合同确认弹窗（设计文档 §"误关联兜底"）：
      命中指纹后展示 5 秒倒计时，确认即调 link-contract；点取消则记录 contractId 已见过，
      本轮 30 秒轮询不再提示同一合同。
    -->
    <template v-if="pendingMatch">
      <div :class="$style.overlay">
        <div :class="[C.DraftConditionEditor.form, C.fonts.fontRegular, $style.confirmCard]">
          <SectionHeader>检测到匹配的合同</SectionHeader>
          <div :class="$style.confirmBody">
            <div
              >合同 ID：<strong>{{ pendingMatch.contractId }}</strong></div
            >
            <div>指纹摘要：{{ pendingMatch.fingerprintSummary }}</div>
            <div :class="$style.countdown">{{ confirmCountdown }} 秒后自动关联</div>
          </div>
          <ActionBar>
            <PrunButton primary :disabled="loading" @click="onConfirmAutoLink">立即关联</PrunButton>
            <PrunButton neutral @click="onCancelAutoLink">取消</PrunButton>
          </ActionBar>
        </div>
      </div>
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
.confirmCard {
  padding: 12px 16px 16px;
  width: 380px;
}
.confirmBody {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
}
.countdown {
  color: var(--text-warning, #f0ad4e);
  font-weight: bold;
  margin-top: 4px;
}
</style>
