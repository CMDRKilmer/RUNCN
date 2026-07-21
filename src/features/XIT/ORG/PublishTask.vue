<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TaskContractJson, TaskType } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import { HttpError } from '@src/infrastructure/org-api/client';
import SectionHeader from '@src/components/SectionHeader.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import TextInput from '@src/components/forms/TextInput.vue';

type ItemType = { ticker: string; amount: number; price?: number };

const type = ref<Extract<TaskType, 'BUY' | 'SELL' | 'SHIP'>>('BUY');
const currency = ref('ICA');
const contractName = ref('');
const location = ref('');
const origin = ref('');
const destination = ref('');
// `price` 在不同类型下语义不同：
//   - SHIP: 作为"运费"（对齐 CONTGEN 字段命名）
//   - BUY/SELL: 该字段从表单隐藏（运费的 PrUn 概念仅在 SHIP 下存在）
//              每行 `item.price` 必填
// 保留 ref 是为了让 SHIP 路径写入 contractJson.price 不需要分支。
const price = ref<number | undefined>(undefined);
const deadline = ref<number | undefined>(undefined);
const items = ref<ItemType[]>([{ ticker: '', amount: 0, price: 0 }]);
// 有效期：发布后多少小时自动取消（架构 §12.21 任务有效期）
const expiresAfterHours = ref<number>(72);

const error = ref('');
const loading = ref(false);
const publishedTaskId = ref<string | null>(null);

const isShip = computed(() => type.value === 'SHIP');

const canSubmit = computed(() => {
  if (loading.value) {
    return false;
  }
  if (items.value.length === 0) {
    return false;
  }
  for (const item of items.value) {
    if (!item.ticker || item.amount <= 0) {
      return false;
    }
  }
  if (isShip.value) {
    if (!origin.value || !destination.value || origin.value === destination.value) {
      return false;
    }
    if (price.value === undefined || price.value <= 0) {
      return false;
    }
  } else {
    // BUY / SELL：必须有 location + 每行物品单价必填 > 0（CONTGEN 语义）
    if (!location.value) {
      return false;
    }
    const allRowsHavePrice = items.value.every(
      i => i.price !== undefined && i.price !== null && Number(i.price) > 0,
    );
    if (!allRowsHavePrice) {
      return false;
    }
  }
  return true;
});

// 类型变化时重置仅 SHIP 适用的字段，避免 BUY/SELL 留下幽灵 price。
watch(type, (next, prev) => {
  if (next !== 'SHIP' && prev === 'SHIP') {
    price.value = undefined;
  }
  // SHIP 不需要每行 price；BUY/SELL 反之亦然。切换时归零以免影响 canSubmit。
  items.value.forEach(it => {
    if (next === 'SHIP') {
      it.price = 0;
    }
  });
});

function addItem() {
  items.value.push({ ticker: '', amount: 0, price: isShip.value ? 0 : 0 });
}

function removeItem(i: number) {
  items.value.splice(i, 1);
}

async function onPublish() {
  if (!canSubmit.value) {
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    // 构造 contractJson（与 CONTGEN.vue ContractJson 对齐）
    const contractJson: TaskContractJson = {
      template: type.value,
      currency: currency.value,
      name: contractName.value || undefined,
      location: isShip.value ? undefined : location.value,
      origin: isShip.value ? origin.value : undefined,
      destination: isShip.value ? destination.value : undefined,
      price: price.value,
      deadline: deadline.value,
      items: items.value.map(i => ({
        commodity: i.ticker,
        amount: i.amount,
        price: i.price,
      })),
    };
    const expiresAt = new Date(Date.now() + expiresAfterHours.value * 3600_000).toISOString();
    const task = await tasksApi.createTask({ type: type.value, contractJson, expiresAt });
    publishedTaskId.value = task.id;
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  publishedTaskId.value = null;
  type.value = 'BUY';
  currency.value = 'ICA';
  contractName.value = '';
  location.value = '';
  origin.value = '';
  destination.value = '';
  price.value = undefined;
  deadline.value = undefined;
  items.value = [{ ticker: '', amount: 0, price: 0 }];
  expiresAfterHours.value = 72;
}
</script>

<template>
  <div :class="[C.DraftConditionEditor.form, C.fonts.fontRegular, $style.container]">
    <div v-if="publishedTaskId" :class="$style.success">
      已发布，任务 ID：{{ publishedTaskId }}
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
        <Active label="有效期（小时）">
          <NumberInput v-model="expiresAfterHours" :min="1" />
        </Active>
      </div>

      <SectionHeader>物品清单</SectionHeader>
      <div :class="$style.items">
        <div v-for="(item, i) in items" :key="i" :class="$style.itemRow">
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
          <PrunButton danger inline @click="removeItem(i)">删除</PrunButton>
        </div>
        <ActionBar>
          <PrunButton dark inline type="button" @click="addItem">添加物品</PrunButton>
        </ActionBar>
      </div>

      <div v-if="error" :class="$style.error">{{ error }}</div>

      <ActionBar>
        <PrunButton primary type="submit" :disabled="!canSubmit">
          {{ loading ? '发布中...' : '发布任务' }}
        </PrunButton>
      </ActionBar>
    </form>
  </div>
</template>

<style module>
.container {
  padding: 8px 12px 12px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.row > * {
  flex: 1;
  min-width: 140px;
}
.items {
  border: 1px solid var(--panel-border);
  padding: 8px;
  background: var(--panel-background-alt);
}
.itemRow {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
  align-items: flex-end;
}
.itemRow > :first-child {
  flex: 1;
}
.itemRow > :nth-child(2) {
  flex: 0 0 100px;
}
.itemRow > :nth-child(3) {
  flex: 0 0 110px;
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
