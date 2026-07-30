<script setup lang="ts">
// 发布挂单对话框（模态）。被 MarketView（BUY/SELL）和 TaskList shipping（SHIP）共用。
//
// 设计要点：
//   - expiresAt 不再发送——挂单永久存在（无有效期）
//   - 由 props.initialType 决定默认 BUY / SELL / SHIP
//   - props.initialTicker / initialPrice 用于从市场行/列表预填
//   - 提交成功返回 emit('published', listing)，父组件刷新视图
//   - 取消 emit('close') 关闭对话框
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

interface InitialData {
  type?: ListingType;
  ticker?: string;
  amount?: number;
  price?: number;
  currency?: string;
  location?: string;
  origin?: string;
  destination?: string;
  contractName?: string;
}

const props = defineProps<{
  initialData?: InitialData;
}>();

const emit = defineEmits<{
  close: [];
  published: [listing: { id: string; type: ListingType }];
}>();

// 内部表单状态
const type = ref<ListingType>(props.initialData?.type ?? 'BUY');
const currency = ref(props.initialData?.currency ?? 'ICA');
const contractName = ref(props.initialData?.contractName ?? '');
const location = ref(props.initialData?.location ?? '');
const origin = ref(props.initialData?.origin ?? '');
const destination = ref(props.initialData?.destination ?? '');
const price = ref<number | undefined>(undefined); // SHIP 运费
const item = ref({
  ticker: props.initialData?.ticker ?? '',
  amount: props.initialData?.amount ?? 0,
  price: props.initialData?.price ?? 0,
});
const error = ref('');
const loading = ref(false);
const publishedListingId = ref<string | null>(null);

const isShip = computed(() => type.value === 'SHIP');

const canSubmit = computed(() => {
  if (loading.value) return false;
  if (!item.value.ticker || item.value.amount <= 0) return false;
  if (isShip.value) {
    if (!origin.value || !destination.value || origin.value === destination.value) return false;
    if (price.value === undefined || price.value <= 0) return false;
  } else {
    if (!location.value) return false;
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
  if (!canSubmit.value) return;
  loading.value = true;
  error.value = '';
  try {
    // 永久挂单：不发送 expiresAt
    const listing = await listingsApi.createListing({
      type: type.value,
      commodity: item.value.ticker,
      amount: item.value.amount,
      price: isShip.value ? (price.value ?? 0) : (item.value.price ?? 0),
      currency: currency.value,
      location: isShip.value ? undefined : location.value,
      origin: isShip.value ? origin.value : undefined,
      destination: isShip.value ? destination.value : undefined,
    });
    publishedListingId.value = listing.id;
    emit('published', listing);
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  publishedListingId.value = null;
  type.value = props.initialData?.type ?? 'BUY';
  currency.value = props.initialData?.currency ?? 'ICA';
  contractName.value = '';
  location.value = props.initialData?.location ?? '';
  origin.value = props.initialData?.origin ?? '';
  destination.value = props.initialData?.destination ?? '';
  price.value = undefined;
  item.value = {
    ticker: props.initialData?.ticker ?? '',
    amount: props.initialData?.amount ?? 0,
    price: props.initialData?.price ?? 0,
  };
}
</script>

<template>
  <div :class="$style.backdrop" @click.self="emit('close')">
    <div :class="$style.modal">
      <div :class="[C.DraftConditionEditor.form, C.fonts.fontRegular, $style.container]">
        <div v-if="publishedListingId" :class="$style.success">
          已发布挂单，挂单 ID：{{ publishedListingId }}
          <PrunButton primary inline @click="resetForm">再发布一个</PrunButton>
          <PrunButton dark inline @click="emit('close')">关闭</PrunButton>
        </div>

        <form v-else :class="$style.form" @submit.prevent="onPublish">
          <SectionHeader>{{ isShip ? '发布运输挂单' : '发布挂单' }}</SectionHeader>
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
            <Active v-if="isShip" label="运费">
              <NumberInput v-model="price" :min="0" />
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
            <PrunButton dark inline @click="emit('close')">取消</PrunButton>
          </ActionBar>
        </form>
      </div>
    </div>
  </div>
</template>

<style module>
.backdrop {
  /* position: absolute so the popup is constrained to the closest
     positioned ancestor (ORG window tile frame body), not the viewport. */
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  overflow: auto;
}
.modal {
  background: var(--panel-background, #1a1a1a);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  max-width: 520px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
}
.container {
  padding: 8px 12px 12px;
  width: 100%;
  box-sizing: border-box;
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
  color: var(--rp-color-red, #d9534f);
  padding: 8px;
  background: var(--panel-background-alt);
}
.success {
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  background: var(--panel-background-alt);
  color: var(--rp-color-green, #5cb85c);
}
</style>
