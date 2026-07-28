<script setup lang="ts">
// ListingDetail：挂单详情面板（在 "我的发布" 里展开 listing 行时使用）。
// 展示 listing 完整字段 + 取消挂单按钮。
// 取消成功后通过 emit('cancelled') 让父组件（TaskList）刷新列表。
//
// 字段顺序、命名、布局严格对齐 TaskDetail：类型 / 名称 / 货币 / 位置 / 路径 / 单价 / 期限 /
//   发布者 / 关联合同 / 有效期 / 创建时间。
// 关联合同字段：listing 没有合同（合同是接取后才生成的 task.contractId），所以固定显示"—"。
// 物品清单：listing 是单商品（amount/commodity 已展示），不重复列。
import { computed, ref } from 'vue';
import type { OrgListing, OrgUser } from '@src/infrastructure/org-api/types';
import * as listingsApi from '@src/infrastructure/org-api/listings';
import { formatAmountWithCurrency, formatNumber } from './utils';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import ActionBar from '@src/components/ActionBar.vue';

const props = defineProps<{
  listing: OrgListing;
  currentUser: OrgUser;
}>();

const emit = defineEmits<{
  close: [];
  cancelled: [listing: OrgListing];
}>();

const cancelling = ref(false);
const cancelError = ref('');

// 只有 publisher 本人才能取消（后端会二次校验）。
const canCancel = computed(() => {
  const userId = props.currentUser?.id;
  if (!userId) return false;
  return props.listing.publisherId === userId;
});

function getTypeLabel(type: OrgListing['type']) {
  switch (type) {
    case 'BUY':
      return '采购';
    case 'SELL':
      return '出售';
    case 'SHIP':
      return '运输';
    default:
      return type;
  }
}

function getStatusLabel(status: OrgListing['status']) {
  switch (status) {
    case 'OPEN':
      return '挂单中';
    case 'CLOSED':
      return '已售完';
    case 'CANCELLED':
      return '已取消';
    default:
      return status;
  }
}

async function onCancel() {
  if (!canCancel.value || cancelling.value) return;
  if (
    !confirm(
      `确认取消挂单 ${props.listing.type} ${formatNumber(props.listing.amount)} ${props.listing.commodity} ？`,
    )
  ) {
    return;
  }
  cancelling.value = true;
  cancelError.value = '';
  try {
    const updated = await listingsApi.cancelListing(props.listing.id);
    emit('cancelled', updated);
    emit('close');
  } catch (err) {
    cancelError.value = String(err);
  } finally {
    cancelling.value = false;
  }
}

function onClose() {
  emit('close');
}
</script>

<template>
  <div :class="$style.detail">
    <!-- 头部：返回按钮 + 状态徽章（与 TaskDetail 一致） -->
    <div :class="$style.header">
      <PrunButton dark inline @click="onClose">← 返回</PrunButton>
      <span :class="$style.status">{{ getStatusLabel(listing.status) }}</span>
    </div>

    <!-- 基本信息：字段顺序、key 名、布局与 TaskDetail 严格一致 -->
    <SectionHeader>基本信息</SectionHeader>
    <div :class="$style.kv">
      <div>
        <span :class="$style.key">类型</span>
        {{ getTypeLabel(listing.type) }}
      </div>
      <div>
        <span :class="$style.key">名称</span>
        {{ listing.commodity }}
      </div>
      <div>
        <span :class="$style.key">货币</span>
        {{ listing.currency }}
      </div>
      <div v-if="listing.location">
        <span :class="$style.key">位置</span>
        {{ listing.location }}
      </div>
      <div v-if="listing.origin || listing.destination">
        <span :class="$style.key">路径</span>
        {{ listing.origin ?? '?' }} → {{ listing.destination ?? '?' }}
      </div>
      <div>
        <!--
          listing 单价 + amount 不一定 1:1 配对：用 amount 字段做"总量"，price 做"单价"，
          当 price 不为 0 时展示，价签带货币后缀（对齐 TaskDetail 的"总价"展示风格）。
        -->
        <span :class="$style.key">单价</span>
        {{ formatAmountWithCurrency(listing.price, listing.currency) }}
      </div>
      <div>
        <span :class="$style.key">总量</span>
        {{ formatNumber(listing.amount) }} {{ listing.commodity }}
      </div>
      <div>
        <span :class="$style.key">剩余</span>
        {{ formatNumber(listing.remainingAmount) }} {{ listing.commodity }}
      </div>
      <div>
        <span :class="$style.key">发布者</span>
        {{ listing.publisherUsername }} ({{ listing.publisherCompanyCode }})
      </div>
      <div>
        <span :class="$style.key">关联合同</span>
        <!-- listing 阶段没有合同；合同在接取后才生成。统一展示"—"占位，对齐 TaskDetail 的展示位置 -->
        —
      </div>
      <div v-if="listing.expiresAt">
        <span :class="$style.key">有效期</span>
        {{ new Date(listing.expiresAt).toLocaleString() }}
      </div>
      <div>
        <span :class="$style.key">创建时间</span>
        {{ new Date(listing.createdAt).toLocaleString() }}
      </div>
    </div>

    <section v-if="cancelError" :class="$style.error">{{ cancelError }}</section>

    <!-- 操作栏：与 TaskDetail 一致的 ActionBar -->
    <ActionBar>
      <PrunButton
        v-if="canCancel && listing.status === 'OPEN'"
        primary
        :disabled="cancelling"
        @click="onCancel">
        {{ cancelling ? '取消中…' : '取消挂单' }}
      </PrunButton>
    </ActionBar>
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
/* KV 行：与 TaskDetail 完全一致——key 右对齐、value 左对齐、虚线分隔 */
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
.error {
  padding: 8px;
  color: var(--text-negative);
  background: var(--panel-background-alt);
  margin: 8px 0;
}
</style>
