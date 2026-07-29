<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { OrgTask, OrgListing, OrgUser, PollScope } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import * as listingsApi from '@src/infrastructure/org-api/listings';
import TaskDetail from './TaskDetail.vue';
import ListingDetail from './ListingDetail.vue';
import LinkContract from './LinkContract.vue';
import EmptyState from './EmptyState.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import PublishOverlay from './PublishOverlay.vue';
import { formatAmountWithCurrency, formatNumber, statusLabel } from './utils';

// UI Tab 键：'shipping' 仅展示 SHIP 任务；'published' / 'claimed' 直接透传给 API。
// 后端 /tasks scope 枚举是 'board' | 'published' | 'claimed'，不接受 'shipping'。
type UiScope = 'shipping' | 'published' | 'claimed';

// 显示行：要么是真实 task，要么是来自 listings 的虚拟行（仅在 'published' 视图出现）。
//   虚拟行展示 OPEN 状态的挂单——这些还没有 task（接取后才生成 task）。
type DisplayRow = { kind: 'task'; task: OrgTask } | { kind: 'listing'; listing: OrgListing };

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

const rows = ref<DisplayRow[]>([]);
const loading = ref(false);
const error = ref('');
const selectedTask = ref<OrgTask | null>(null);
const selectedListing = ref<OrgListing | null>(null);
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
    const taskRows: DisplayRow[] = result.items.map(t => ({ kind: 'task', task: t }));

    // 'published' 视图额外拉取 /listings?scope=mine，把 OPEN 状态的挂单也展示出来。
    // 这些挂单还没被接取，所以没有 task；显示成"挂单中"虚拟行。
    if (props.scope === 'published') {
      const listings = await listingsApi.listListings({ scope: 'mine', limit: 100 });
      const listingRows: DisplayRow[] = listings
        .filter(l => l.status === 'OPEN')
        .map(l => ({ kind: 'listing', listing: l }));
      // 合并：task 行在前（已接取/合同中），listing 行在后（挂单中）。
      // 用 createdAt 降序，listings 表 createdAt 是 ISO8601，task 也是 ISO8601——可比较。
      rows.value = [...taskRows, ...listingRows].sort((a, b) => {
        const aTime = a.kind === 'task' ? a.task.createdAt : a.listing.createdAt;
        const bTime = b.kind === 'task' ? b.task.createdAt : b.listing.createdAt;
        return bTime.localeCompare(aTime);
      });
    } else {
      rows.value = taskRows;
    }
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
    selectedListing.value = null;
    showLinkContract.value = false;
    void refresh();
  },
);

// 详情更新后同步到本地列表（拉取最新 task 后再用 returned 对象替换）
function onTaskUpdated(updated: OrgTask) {
  selectedTask.value = updated;
  const idx = rows.value.findIndex(r => r.kind === 'task' && r.task.id === updated.id);
  if (idx >= 0) {
    rows.value.splice(idx, 1, { kind: 'task', task: updated });
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
  const idx = rows.value.findIndex(r => r.kind === 'task' && r.task.id === updated.id);
  if (idx >= 0) {
    rows.value.splice(idx, 1, { kind: 'task', task: updated });
  }
  void refresh();
}

// 任务被发布者物理删除后（已 CANCELLED/COMPLETED），从本地列表移除并 refresh。
// 这里的快照是删除前的 task，后端目前 GET 404，无需保留。
function onTaskDeleted(snapshot: OrgTask) {
  selectedTask.value = null;
  showLinkContract.value = false;
  const idx = rows.value.findIndex(r => r.kind === 'task' && r.task.id === snapshot.id);
  if (idx >= 0) {
    rows.value.splice(idx, 1);
  }
  void refresh();
}

onBeforeUnmount(() => {
  selectedTask.value = null;
  selectedListing.value = null;
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
  // task 行被点开时收起 listing 详情（互斥）
  selectedListing.value = null;
}

function selectListing(listing: OrgListing) {
  // 再次点击同一行收起（toggle 行为）
  if (selectedListing.value?.id === listing.id) {
    selectedListing.value = null;
  } else {
    selectedListing.value = listing;
    // 收起 task 详情（互斥）
    selectedTask.value = null;
    showLinkContract.value = false;
  }
}

// listing 详情关闭：清空 selectedListing + 触发整列表 refresh。
function onListingDetailClosed() {
  selectedListing.value = null;
  void refresh();
}

// listing 取消成功：refresh 整列表（listings 行可能消失或变 CLOSED）。
function onListingCancelled() {
  void refresh();
}

// 发布挂单对话框：仅 shipping tab 显示发布按钮（默认 SHIP）
const showPublishOverlay = ref(false);
function openPublishShipping() {
  showPublishOverlay.value = true;
}
function onPublishedShipping() {
  showPublishOverlay.value = false;
  void refresh();
}
</script>

<template>
  <div :class="$style.list">
    <!-- 标题行：左侧 SectionHeader，shipping tab 右侧带"发布运输"按钮 -->
    <div :class="$style.titleRow">
      <SectionHeader>{{ scopeLabel }}</SectionHeader>
      <PrunButton v-if="scope === 'shipping'" primary inline @click="openPublishShipping">
        发布运输
      </PrunButton>
    </div>

    <!-- 发布对话框 -->
    <PublishOverlay
      v-if="showPublishOverlay"
      :initial-data="{ type: 'SHIP' }"
      @close="showPublishOverlay = false"
      @published="onPublishedShipping" />

    <div v-if="loading" :class="$style.info">加载中...</div>
    <div v-else-if="error" :class="$style.error">{{ error }}</div>
    <template v-else-if="rows.length === 0">
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
          <template v-for="row in rows" :key="row.kind === 'task' ? row.task.id : row.listing.id">
            <!-- task 行：可点开 TaskDetail 做合同关联等操作 -->
            <template v-if="row.kind === 'task'">
              <tr
                :class="[$style.row, selectedTask?.id === row.task.id ? $style.selected : '']"
                @click="selectTask(row.task)">
                <td :class="$style.type">{{ getTypeLabel(row.task.type) }}</td>
                <td>{{ row.task.contractJson.name || row.task.type }}</td>
                <td>{{ getItemSummary(row.task) }}</td>
                <td>{{ getLocationText(row.task) }}</td>
                <td>{{ row.task.publisherUsername }}</td>
                <td>{{ getPriceText(row.task) }}</td>
                <td :style="{ color: getStatusColor(row.task.status) }">{{
                  statusLabel(row.task.status, row.task.contractId)
                }}</td>
              </tr>
              <tr v-if="selectedTask?.id === row.task.id" :class="$style.detailRow">
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
            <!-- listing 行：纯挂单（OPEN）展示，点击展开 ListingDetail -->
            <template v-else>
              <tr
                :class="[$style.row, selectedListing?.id === row.listing.id ? $style.selected : '']"
                @click="selectListing(row.listing)">
                <td :class="$style.type">{{ row.listing.type === 'BUY' ? '采购' : '出售' }}</td>
                <td>{{ row.listing.type }} {{ row.listing.commodity }}</td>
                <td>
                  {{ formatNumber(row.listing.remainingAmount) }} /
                  {{ formatNumber(row.listing.amount) }} {{ row.listing.commodity }}
                </td>
                <td>{{ row.listing.location ?? '—' }}</td>
                <td>{{ row.listing.publisherUsername }}</td>
                <td>{{ formatAmountWithCurrency(row.listing.price, row.listing.currency) }}</td>
                <td :style="{ color: 'var(--text-muted)' }">挂单中</td>
              </tr>
              <tr v-if="selectedListing?.id === row.listing.id" :class="$style.detailRow">
                <td colspan="7">
                  <ListingDetail
                    :listing="selectedListing"
                    :current-user="currentUser"
                    @close="onListingDetailClosed"
                    @cancelled="onListingCancelled" />
                </td>
              </tr>
            </template>
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
.titleRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
