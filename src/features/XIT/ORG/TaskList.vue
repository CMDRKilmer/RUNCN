<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { OrgTask, OrgUser, PollScope } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import TaskDetail from './TaskDetail.vue';
import LinkContract from './LinkContract.vue';
import EmptyState from './EmptyState.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import { formatAmountWithCurrency, formatNumber, statusLabel } from './utils';

// UI Tab 键：'shipping' 仅展示 SHIP 任务；'published' / 'claimed' 直接透传给 API。
// 后端 /tasks scope 枚举是 'board' | 'published' | 'claimed'，不接受 'shipping'。
type UiScope = 'shipping' | 'published' | 'claimed';

const scopeLabel = computed(() => {
  switch (props.scope) {
    case 'shipping':
      return '运输';
    case 'published':
      return '我的发布';
    case 'claimed':
      return '我的接取';
    default:
      return '任务列表';
  }
});

const props = defineProps<{
  scope: UiScope;
  currentUser: OrgUser;
}>();

const tasks = ref<OrgTask[]>([]);
const loading = ref(false);
const error = ref('');
const selectedTask = ref<OrgTask | null>(null);
// LinkContract 是 fixed overlay（z-index:1000），TaskDetail 也是 fixed overlay（z-index:1100）。
// 必须放在 TaskDetail 外，独立成兄弟层；层级靠 z-index 区分（LinkContract 略低）。
const showLinkContract = ref(false);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    // UI scope → API scope 翻译：
    //   'shipping' → 'board' + type=SHIP（运输 Tab 只看 SHIP）
    //   'published' / 'claimed' → 原样透传
    const apiScope: PollScope = props.scope === 'shipping' ? 'board' : props.scope;
    const result = await tasksApi.listTasks({
      scope: apiScope,
      type: props.scope === 'shipping' ? 'SHIP' : undefined,
      limit: 100,
    });
    tasks.value = result.items;
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
// scope 切换时（同 ORG pane 内 shipping/published/claimed 互切）清除详情与子弹窗，
// 防止旧 scope 的 TaskDetail 留在新列表下方。
// 注意：LinkContract 内嵌在 TaskList 模板里，selectedTask=null 之后它的 v-if 已会收起。
watch(
  () => props.scope,
  () => {
    selectedTask.value = null;
    showLinkContract.value = false;
    void refresh();
  },
);

// 详情更新后同步到本地列表（拉取最新 task 后再用 returned 对象替换）
function onTaskUpdated(updated: OrgTask) {
  selectedTask.value = updated;
  const idx = tasks.value.findIndex(t => t.id === updated.id);
  if (idx >= 0) {
    tasks.value.splice(idx, 1, updated);
  }
}

// 简单刷新：外部可通过轮询间接刷新；详情页关闭后重新拉取
function onDetailClosed() {
  selectedTask.value = null;
  showLinkContract.value = false;
  void refresh();
}

// 详情页要求打开 LinkContract 时转发事件（TaskDetail 不直接持有 LinkContract）
function onRequestLinkContract() {
  if (selectedTask.value) {
    showLinkContract.value = true;
  }
}

async function onContractLinked(updated: OrgTask) {
  selectedTask.value = updated;
  showLinkContract.value = false;
  const idx = tasks.value.findIndex(t => t.id === updated.id);
  if (idx >= 0) {
    tasks.value.splice(idx, 1, updated);
  }
  void refresh();
}

// 任务被发布者物理删除后（已 CANCELLED/COMPLETED），从本地列表移除并 refresh。
// 这里的快照是删除前的 task，后端目前 GET 404，无需保留。
function onTaskDeleted(snapshot: OrgTask) {
  selectedTask.value = null;
  showLinkContract.value = false;
  const idx = tasks.value.findIndex(t => t.id === snapshot.id);
  if (idx >= 0) {
    tasks.value.splice(idx, 1);
  }
  void refresh();
}

onBeforeUnmount(() => {
  selectedTask.value = null;
  showLinkContract.value = false;
});

// 表格单元格格式化函数
function getItemSummary(task: OrgTask): string {
  const items = task.contractJson.items ?? [];
  if (items.length === 0) {
    return '无物品';
  }
  const head = `${formatNumber(items[0].amount)}× ${items[0].commodity}`;
  if (items.length === 1) {
    return head;
  }
  return `${head} 等 ${items.length} 项`;
}

function getLocationText(task: OrgTask): string {
  const c = task.contractJson;
  if (task.type === 'SHIP') {
    return `${c.origin ?? '?'} → ${c.destination ?? '?'}`;
  }
  return c.location ?? '—';
}

function getPriceText(task: OrgTask): string {
  const c = task.contractJson;
  if (c.price !== undefined) {
    return formatAmountWithCurrency(c.price, c.currency);
  }
  const itemsTotal = (c.items ?? []).reduce((sum, i) => sum + (i.price ?? 0) * i.amount, 0);
  return itemsTotal > 0 ? formatAmountWithCurrency(itemsTotal, c.currency) : '—';
}

function getTypeLabel(type: OrgTask['type']): string {
  switch (type) {
    case 'BUY':
      return '采购';
    case 'SELL':
      return '出售';
    case 'SHIP':
      return '运输';
    case 'LOAN':
      return '借贷';
    default:
      return type;
  }
}

function getStatusColor(status: OrgTask['status']): string {
  switch (status) {
    case 'PUBLISHED':
      return 'var(--text-muted)';
    case 'AWAITING_CONTRACT':
      return 'var(--text-warning, #f0ad4e)';
    case 'IN_PROGRESS':
      return 'var(--accent)';
    case 'COMPLETED':
      return 'var(--text-positive, #5cb85c)';
    case 'CANCELLED':
      return 'var(--text-negative, #d9534f)';
    default:
      return 'inherit';
  }
}

function selectTask(task: OrgTask) {
  selectedTask.value = task;
}
</script>

<template>
  <div :class="$style.list">
    <!-- 用 PrUn 风格小节标题（SectionHeader 已是 PrUn 官方样式） -->
    <SectionHeader>{{ scopeLabel }}</SectionHeader>

    <div v-if="loading" :class="$style.info">加载中...</div>
    <div v-else-if="error" :class="$style.error">{{ error }}</div>
    <template v-else-if="tasks.length === 0">
      <EmptyState message="暂无任务" />
    </template>
    <template v-else>
      <table :class="$style.table">
        <thead>
          <tr>
            <th>类型</th>
            <th>标题</th>
            <th>物品</th>
            <th>{{ scope === 'shipping' ? '路线' : '位置/路线' }}</th>
            <th>{{ scope === 'shipping' ? '发布者' : '状态' }}</th>
            <th>价格</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="task in tasks" :key="task.id">
            <tr
              :class="[$style.row, selectedTask?.id === task.id ? $style.selected : '']"
              @click="selectTask(task)">
              <td :class="$style.type">{{ getTypeLabel(task.type) }}</td>
              <td>{{ task.contractJson.name || task.type }}</td>
              <td>{{ getItemSummary(task) }}</td>
              <td>{{ getLocationText(task) }}</td>
              <td>{{ task.publisherUsername }}</td>
              <td>{{ getPriceText(task) }}</td>
              <td :style="{ color: getStatusColor(task.status) }">{{
                statusLabel(task.status, task.contractId)
              }}</td>
            </tr>
            <tr v-if="selectedTask?.id === task.id" :class="$style.detailRow">
              <td colspan="7">
                <TaskDetail
                  :task="selectedTask"
                  :current-user="currentUser"
                  @close="onDetailClosed"
                  @updated="onTaskUpdated"
                  @link-contract="onRequestLinkContract"
                  @deleted="onTaskDeleted" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </template>

    <LinkContract
      v-if="showLinkContract && selectedTask"
      :task="selectedTask"
      :current-user="currentUser"
      @linked="onContractLinked"
      @cancel="showLinkContract = false" />
  </div>
</template>

<style module>
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}
.info {
  padding: 16px;
  color: var(--text-muted);
  text-align: center;
}
.error {
  padding: 16px;
  color: var(--text-negative);
  text-align: center;
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
.table th {
  background: var(--panel-background-alt);
  font-weight: 600;
}
.row {
  cursor: pointer;
}
.row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.selected {
  background: rgba(255, 255, 255, 0.08);
}
.detailRow > td {
  padding: 8px;
  background: var(--panel-background-alt);
}
.type {
  color: var(--accent);
  font-weight: 600;
}
</style>
