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
  dismissAutoLink,
} from '@src/infrastructure/org-api/auto-link';
import { sendTaskToContd, formatAmountWithCurrency, formatNumber, statusLabel } from './utils';
import NoteEditor from './NoteEditor.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import PrunLink from '@src/components/PrunLink.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';

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
// 阶段 4：父子任务已废弃（解耦后接取走 /listings 端点）。
//   没有"父任务"概念，不需要加载父任务 publisher。

// 自动关联合同状态（ORG 任务接取后默认开启自动关联）。
// canAutoLink=true → 自动调 startAutoLink；用户可手动关闭（停止轮询）。
const autoLinkRunning = ref(isAutoLinkRunning(props.task.id));

watch(
  () => props.task,
  t => {
    localTask.value = t;
  },
  { immediate: true },
);

// 自动关联 watch 块：必须在 canAutoLink 声明之后才注册（避免 TDZ），
// 见下方 canAutoLink 声明后的同段代码。

// 监听合同状态变化（架构 §7.3）
watchEffect(() => {
  watchContractStatus(localTask.value);
});

// 已 link 合同的 PrUn 完整对象：用于「打开合同」链接（用 localId 触发 CONT 命令）。
// task.contractId 来自后端存的是 PrUn 客户端的「合同 ID」（即 Contract.localId 短码，
// 玩家在 PrUn 客户端里看见的"U787KK6"格式）。PrUn 内部 Contract.id 是 FQID（base32 ulid），
// 与 shortId 不同；entity store 的 getById 用 Contract.id 做 key，找不到 shortId。
//
// 改用 contractsStore.all 直接遍历，按 localId 等值匹配，最稳。
// contractsStore.fetched 必须为 true 否则 all 是 undefined（CONTRACTS_CONTRACTS
// 消息还没收到）。computed 依赖 .value 是响应式的，fetched 变 true 后会重算。
const linkedContract = computed(() => {
  const id = localTask.value.contractId;
  if (!id) return null;
  if (!contractsStore.fetched.value) return null;
  const all = contractsStore.all.value;
  if (!all) return null;
  return all.find(c => c.localId === id) ?? all.find(c => c.id === id) ?? null;
});

// 主动拉取：task 有 contractId 但 contractsStore 找不到时，触发 PrUn 客户端去
// CONTC 拉取该合同缓存窗口（autoClose=true 不让窗口堆积）。拉取成功后 server 推
// CONTRACTS_CONTRACT 消息，contractsStore 就会自动包含它。
//
// 注意：仅在用户**已经看到这条任务**时拉一次，避免一打开 Org 就发几十个 CONTC。
// 用 watch + 一个 flag 实现 once 语义。
let linkedContractFetchAttempted = false;
console.log(
  '[TaskDetail] mount, task.contractId=',
  localTask.value.contractId,
  'store.fetched=',
  contractsStore.fetched.value,
  'store.all?.length=',
  contractsStore.all.value?.length ?? 'n/a',
);
watch(
  linkedContract,
  contract => {
    const id = localTask.value.contractId;
    if (!id) return;
    if (linkedContractFetchAttempted) return;
    // 等 contractsStore fetch 完成 + 找不到该合同 → 拉一次
    if (!contractsStore.fetched.value) return;
    if (contract) return; // 已经找到，无需拉
    linkedContractFetchAttempted = true;
    console.debug(
      '[TaskDetail] linkedContract not in store, fetching:',
      id,
      'all.count:',
      contractsStore.all.value?.length ?? 0,
    );
    void import('@src/infrastructure/prun-ui/buffers').then(m =>
      m.showBuffer(`CONTC ${id}`, { autoSubmit: true, autoClose: true }),
    );
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearReportedStatus(localTask.value.id);
  stopAutoLink(localTask.value.id);
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
// 释放按钮可见条件：状态 AWAITING_CONTRACT 且我是 claimer
const canRelease = computed(
  () => localTask.value.status === 'AWAITING_CONTRACT' && isClaimer.value,
);
const canCancel = computed(() => canCancelTask(props.currentUser, localTask.value));
// 仅在 status 不是 terminal（CANCELLED / COMPLETED）时显示"取消任务"按钮。
const canShowCancelButton = computed(
  () =>
    canCancel.value &&
    localTask.value.status !== 'CANCELLED' &&
    localTask.value.status !== 'COMPLETED',
);
// 重新发布：仅 publisher 自己可把 CANCELLED 状态的任务转回 PUBLISHED。
const canRepublish = computed(() => localTask.value.status === 'CANCELLED' && isPublisher.value);
// CANCELLED / COMPLETED 状态下：仅发布者可物理删除。
const canDelete = computed(() => canDeleteTask(props.currentUser, localTask.value));
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

function onStartAutoLink() {
  // 若 session 已存在（多半是全局 ORG.vue 先注册的"无 UI 弹窗"session），
  // 先 stop 再 start，让本组件的 callbacks（带 UI 弹窗）接管。
  if (isAutoLinkRunning(localTask.value.id)) {
    stopAutoLink(localTask.value.id);
  }
  startAutoLink(localTask.value, {
    onStateChange: state => {
      autoLinkRunning.value = state === 'running';
    },
    onMatch: () => {
      // 自动关联，不弹确认窗
      return Promise.resolve(true);
    },
    onLinked: updated => {
      localTask.value = updated;
      emit('updated', updated);
    },
    onError: err => {
      error.value = err.message;
    },
  });
}

// 自动关联默认开启：canAutoLink 首次为 true 时启动一次（onStartAutoLink
// 内部会处理"已存在 session 则接管"的逻辑）。任务切到 IN_PROGRESS /
// COMPLETED / CANCELLED 后由 auto-link 内部 self-stop。
// 注册顺序：必须在 canAutoLink 声明之后 + onStartAutoLink 函数声明之后，
// 否则 setup 阶段 immediate=true 会触发 TDZ（参见历史上 "Cannot access
// 'canAutoLink' before initialization" 错误）。
watch(
  canAutoLink,
  ok => {
    if (!ok) return;
    onStartAutoLink();
  },
  { immediate: true },
);

function onStopAutoLink() {
  // dismissAutoLink：同时记录 dismissedTaskIds，全局 tick 不会重启。
  dismissAutoLink(localTask.value.id);
  autoLinkRunning.value = false;
}
const showBoardCancelButton = computed(() =>
  shouldShowBoardCancel(props.currentUser, localTask.value),
);

// updateTask 接收任意带 .task 的返回值结构：
//   - OrgTask（旧 API：patchTask / cancelTask / republishTask 等直接返 task）
//   - ReleaseTaskResult（releaseTask：{ task }）
//   - ClaimTaskResult（claimTask：{ task }）
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
  localTask.value = result.task;
  emit('updated', result.task);
}

async function onRelease() {
  const result = await tasksApi.releaseTask(localTask.value.id);
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
  // 谁在操作谁就是 creator：当前用户是发布者则不反转，是接取者则反转
  const creatorIsPublisher = localTask.value.publisherId === props.currentUser.id;
  // 新架构（解耦后）：从 listing claim 生成的 task，task.type 已经是 claimer 视角，
  //   不需要在 invertTemplate 里再反转。task.listingId 存在即标记。
  const taskHasListing = localTask.value.listingId !== undefined;
  // Mirror the try/catch shape of the other handlers above so a
  // failure in the auto-fill helper (e.g. timed-out store update)
  // surfaces in the same error banner as the rest of the panel.
  loading.value = true;
  error.value = '';
  try {
    await sendTaskToContd(
      localTask.value.contractJson,
      localTask.value.type,
      creatorIsPublisher,
      taskHasListing,
    );
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
        <span :class="$style.key">关联合同</span>
        <!--
          关联后可在 PrUn 客户端直接打开合同：
            1) 优先用 contractsStore 里的合同对象展示名字（绿色 link 体验最好）
            2) fallback：纯文本 + 同样可点击，点击会触发 CONT 命令拉取该合同缓存窗口
               （这一招能把 contractsStore 还没缓存的合同拉进来）
        -->
        <PrunLink v-if="linkedContract" inline :command="`CONT ${linkedContract.localId}`">
          {{ linkedContract.name || linkedContract.localId }}
        </PrunLink>
        <PrunLink v-else inline :command="`CONT ${localTask.contractId}`">
          {{ localTask.contractId }}
        </PrunLink>
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
