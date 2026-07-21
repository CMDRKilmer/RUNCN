<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TaskContractJson, TaskType } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import { HttpError } from '@src/infrastructure/org-api/client';

type ItemType = { ticker: string; amount: number; price?: number };

const type = ref<Extract<TaskType, 'BUY' | 'SELL' | 'SHIP'>>('BUY');
const currency = ref('ICA');
const contractName = ref('');
const location = ref('');
const origin = ref('');
const destination = ref('');
const price = ref<number | undefined>(undefined);
const deadline = ref<number | undefined>(undefined);
const items = ref<ItemType[]>([{ ticker: '', amount: 0 }]);
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
    if (!location.value) {
      return false;
    }
    // 价格校验：每行有 price 或顶层有 price
    const hasTopPrice = price.value !== undefined && price.value > 0;
    const hasRowPrice = items.value.every(i => i.price !== undefined && i.price > 0);
    if (!hasTopPrice && !hasRowPrice) {
      return false;
    }
  }
  return true;
});

function addItem() {
  items.value.push({ ticker: '', amount: 0 });
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
  items.value = [{ ticker: '', amount: 0 }];
  expiresAfterHours.value = 72;
}
</script>

<template>
  <div :class="$style.container">
    <div v-if="publishedTaskId" :class="$style.success">
      已发布，任务 ID：{{ publishedTaskId }}
      <button @click="resetForm">再发布一个</button>
    </div>

    <form v-else :class="$style.form" @submit.prevent="onPublish">
      <div :class="$style.row">
        <label>
          类型
          <select v-model="type">
            <option value="BUY">采购 BUY</option>
            <option value="SELL">出售 SELL</option>
            <option value="SHIP">运输 SHIP</option>
          </select>
        </label>
        <label>
          货币
          <select v-model="currency">
            <option>ICA</option>
            <option>NCC</option>
            <option>AIC</option>
            <option>CIS</option>
          </select>
        </label>
        <label>
          合同名称
          <input v-model="contractName" placeholder="可选" />
        </label>
      </div>

      <div :class="$style.row">
        <label v-if="!isShip">
          位置
          <input v-model="location" placeholder="如 ZV-307a" />
        </label>
        <template v-else>
          <label>
            起点
            <input v-model="origin" />
          </label>
          <label>
            终点
            <input v-model="destination" />
          </label>
        </template>
      </div>

      <div :class="$style.row">
        <label>
          顶层总价（可选，BUY/SELL 无行价时必填）
          <input v-model.number="price" type="number" min="0" />
        </label>
        <label>
          期限（天，可选）
          <input v-model.number="deadline" type="number" min="1" />
        </label>
        <label>
          有效期（小时）
          <input v-model.number="expiresAfterHours" type="number" min="1" />
        </label>
      </div>

      <div :class="$style.items">
        <div>物品清单</div>
        <div v-for="(item, i) in items" :key="i" :class="$style.itemRow">
          <input v-model="item.ticker" placeholder="物料代码" />
          <input v-model.number="item.amount" type="number" min="1" placeholder="数量" />
          <input
            v-model.number="item.price"
            type="number"
            min="0"
            placeholder="单价（SHIP 不用）" />
          <button type="button" @click="removeItem(i)">删除</button>
        </div>
        <button type="button" @click="addItem">添加物品</button>
      </div>

      <div v-if="error" :class="$style.error">{{ error }}</div>

      <button type="submit" :disabled="!canSubmit" :class="$style.submit">
        {{ loading ? '发布中...' : '发布任务' }}
      </button>
    </form>
  </div>
</template>

<style module>
.container {
  padding: 12px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.row label {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  flex: 1;
  min-width: 120px;
}
.row input,
.row select {
  padding: 6px 8px;
  border: 1px solid var(--panel-border);
  background: var(--input-background);
  color: var(--text);
}
.items {
  border: 1px solid var(--panel-border);
  padding: 8px;
}
.itemRow {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.itemRow input {
  flex: 1;
  padding: 4px 6px;
  border: 1px solid var(--panel-border);
  background: var(--input-background);
  color: var(--text);
}
.itemRow button {
  padding: 4px 8px;
}
.error {
  color: var(--text-negative);
  padding: 8px;
  background: var(--panel-background-alt);
}
.submit {
  padding: 8px 16px;
  background: var(--accent);
  color: var(--text-on-accent);
  border: 1px solid var(--accent);
  cursor: pointer;
}
.submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.success {
  padding: 16px;
  background: var(--panel-background-alt);
  color: var(--text-positive, #5cb85c);
  text-align: center;
}
</style>
