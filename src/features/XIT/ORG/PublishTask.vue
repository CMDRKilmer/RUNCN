<script setup lang="ts">
// 阶段 4：PublishTask 改为发布挂单（/listings 端点）。
//   单个挂单只挂一个商品（解耦后约束）。"添加物品"按钮移除。
//   提交后返回 OrgListing，保留 id 供用户识别。
import { computed, ref, watch } from 'vue';
import type { ListingType } from '@src/infrastructure/org-api/types';
import * as listingsApi from '@src/infrastructure/org-api/listings';
import { HttpError } from '@src/infrastructure/org-api/client';
import SectionHeader from '@src/components/SectionHeader.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import TextInput from '@src/components/forms/TextInput.vue';

type ItemType = { ticker: string; amount: number; price?: number };

// MarketView 通过此 prop 预填表单（点 "去 PublishTask 发布" 时使用）。
// 不传则按默认空白 + BUY 类型启动。
const props = defineProps<{
  initialData?: {
    type?: ListingType;
    ticker?: string;
    amount?: number;
    price?: number;
    currency?: string;
    location?: string;
    contractName?: string;
  };
}>();

const type = ref<ListingType>(props.initialData?.type ?? 'BUY');
const currency = ref(props.initialData?.currency ?? 'ICA');
const contractName = ref(props.initialData?.contractName ?? '');
const location = ref(props.initialData?.location ?? '');
const origin = ref('');
const destination = ref('');
// `price` 在不同类型下语义不同：
//   - SHIP: 作为"运费"（对齐 CONTGEN 字段命名）
//   - BUY/SELL: 该字段从表单隐藏（运费的 PrUn 概念仅在 SHIP 下存在）
//              单 item 的 price 必填
const price = ref<number | undefined>(undefined);
const deadline = ref<number | undefined>(undefined);
// 单 item（解耦后约束）：挂单只挂一个商品
const item = ref<ItemType>({
  ticker: props.initialData?.ticker ?? '',
  amount: props.initialData?.amount ?? 0,
  price: props.initialData?.price ?? 0,
});
// 有效期：发布后多少天自动取消（架构 §12.21 任务有效期），内部换算成 ISO 时间
const expiresAfterDays = ref<number>(3);

const error = ref('');
const loading = ref(false);
const publishedListingId = ref<string | null>(null);

const isShip = computed(() => type.value === 'SHIP');

const canSubmit = computed(() => {
  if (loading.value) {
    return false;
  }
  if (!item.value.ticker || item.value.amount <= 0) {
    return false;
  }
  if (isShip.value) {
    if (!origin.value || !destination.value || origin.value === destination.value) {
      return false;
    }
    if (price.value === undefined || price.value <= 0) {
      return false;
    }
  } else {
    if (!location.value) {
      return false;
    }
    if (
      item.value.price === undefined ||
      item.value.price === null ||
      Number(item.value.price) <= 0
    ) {
      return false;
    }
  }
  return true;
});

watch(type, (next, prev) => {
  if (next !== 'SHIP' && prev === 'SHIP') {
    price.value = undefined;
  }
});

async function onPublish() {
  if (!canSubmit.value) {
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const listing = await listingsApi.createListing({
      type: type.value,
      commodity: item.value.ticker,
      amount: item.value.amount,
      price: isShip.value ? (price.value ?? 0) : (item.value.price ?? 0),
      currency: currency.value,
      location: isShip.value ? undefined : location.value,
      origin: isShip.value ? origin.value : undefined,
      destination: isShip.value ? destination.value : undefined,
      expiresAt: new Date(Date.now() + expiresAfterDays.value * 86400_000).toISOString(),
    });
    publishedListingId.value = listing.id;
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  publishedListingId.value = null;
  type.value = 'BUY';
  currency.value = 'ICA';
  contractName.value = '';
  location.value = '';
  origin.value = '';
  destination.value = '';
  price.value = undefined;
  deadline.value = undefined;
  item.value = { ticker: '', amount: 0, price: 0 };
  expiresAfterDays.value = 3;
}
</script>

<template>
  <div :class="[C.DraftConditionEditor.form, C.fonts.fontRegular, $style.container]">
    <div v-if="publishedListingId" :class="$style.success">
      已发布挂单，挂单 ID：{{ publishedListingId }}
      <PrunButton primary inline @click="resetForm">再发布一个</PrunButton>
    </div>

    <form v-else :class="$style.form" @submit.prevent="onPublish">
      <SectionHeader>基本信息</SectionHeader>
      <div :class="$style.row">
        <Active label="类型">
          <SelectInput
            v-model="type"
            :options="[
              { value: 'BUY', label: '采购 BUY' },
              { value: 'SELL', label: '出售 SELL' },
              { value: 'SHIP', label: '运输 SHIP' },
            ]" />
        </Active>
        <Active label="货币">
          <SelectInput
            v-model="currency"
            :options="[
              { value: 'ICA', label: 'ICA' },
              { value: 'NCC', label: 'NCC' },
              { value: 'AIC', label: 'AIC' },
              { value: 'CIS', label: 'CIS' },
            ]" />
        </Active>
        <Active label="合同名称（可选）">
          <TextInput v-model="contractName" />
        </Active>
      </div>

      <div :class="$style.row">
        <Active v-if="!isShip" label="位置">
          <TextInput v-model="location" placeholder="如 ZV-307a" />
        </Active>
        <template v-else>
          <Active label="起点">
            <TextInput v-model="origin" />
          </Active>
          <Active label="终点">
            <TextInput v-model="destination" />
          </Active>
        </template>
      </div>

      <div :class="$style.row">
        <!--
          仅 SHIP 任务才有"运费"概念（对齐 PrUn CONTGEN 字段语义）。
          BUY/SELL 任务的价格分布在每行 item.price，不再保留顶层 fallback。
        -->
        <Active v-if="isShip" label="运费">
          <NumberInput v-model="price" :min="0" />
        </Active>
        <Active label="期限（天）">
          <NumberInput v-model="deadline" :min="1" />
        </Active>
        <Active label="有效期（天）">
          <NumberInput v-model="expiresAfterDays" :min="1" />
        </Active>
      </div>

      <SectionHeader>商品</SectionHeader>
      <div :class="$style.items">
        <div :class="$style.itemRow">
          <Active label="物料">
            <TextInput v-model="item.ticker" />
          </Active>
          <Active label="数量">
            <NumberInput v-model="item.amount" :min="1" />
          </Active>
          <!-- SHIP 任务下没有"单价"，所有物品共享顶层"运费" -->
          <Active v-if="!isShip" label="单价">
            <NumberInput v-model="item.price" :min="0" />
          </Active>
        </div>
      </div>

      <div v-if="error" :class="$style.error">{{ error }}</div>

      <ActionBar>
        <PrunButton primary type="submit" :disabled="!canSubmit">
          {{ loading ? '发布中...' : '发布挂单' }}
        </PrunButton>
      </ActionBar>
    </form>
  </div>
</template>

<style module>
.container {
  padding: 8px 12px 12px;
  width: 460px;
  max-width: 100%;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form :global(.SectionHeader) + .row {
  margin-top: 4px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row > :global(*) {
  margin: 0;
  max-width: 100%;
}
.items {
  border: 1px solid var(--panel-border);
  padding: 6px;
  background: var(--panel-background-alt);
}
.itemRow {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
}
.error {
  color: var(--text-negative);
  padding: 8px;
  background: var(--panel-background-alt);
}
.success {
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--panel-background-alt);
  color: var(--text-positive, #5cb85c);
}
</style>
