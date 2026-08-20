<script setup lang="ts">
import { computed, ref } from 'vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import { fixed0 } from '@src/utils/format';
import { EXCHANGE_CODES, buyFuel, getAmountOf, getCxStore, type BuyResult } from './nx-utils';

const nx = computed(() => userData.settings.nx);

// 每行目标输入绑定：确保 targets[code] 存在后直接写回 userData（自动持久化）
function targetFor(code: string) {
  let targets = nx.value.targets;
  if (targets === undefined) {
    targets = {};
    nx.value.targets = targets;
  }
  let t = targets[code];
  if (t === undefined) {
    t = { sf: 0, ff: 0 };
    targets[code] = t;
  }
  return t;
}

const rows = computed(() =>
  EXCHANGE_CODES.map(code => {
    const store = getCxStore(code);
    return {
      code,
      sf: getAmountOf(store, 'SF'),
      ff: getAmountOf(store, 'FF'),
    };
  }),
);

// 目标油量 - 当前油量 = 需要购买的量
function needed(target: number, current: number) {
  return Math.max(0, target - current);
}

const hasAnyNeed = computed(() =>
  rows.value.some(r => {
    const t = targetFor(r.code);
    return needed(t.sf, r.sf) > 0 || needed(t.ff, r.ff) > 0;
  }),
);

// ── 执行 ──
const running = ref(false);
const results = ref<Record<string, string>>({});
const status = ref('');

async function buyAll() {
  if (running.value) {
    return;
  }
  running.value = true;
  results.value = {};
  const tasks: { code: string; ticker: string; promise: Promise<BuyResult> }[] = [];
  for (const row of rows.value) {
    const t = targetFor(row.code);
    for (const [ticker, amount] of [
      ['SF', needed(t.sf, row.sf)],
      ['FF', needed(t.ff, row.ff)],
    ] as const) {
      if (amount > 0) {
        tasks.push({ code: row.code, ticker, promise: buyFuel(row.code, ticker, amount) });
      }
    }
  }
  const total = tasks.length;
  let done = 0;
  status.value = `正在购买（0/${total}）...`;
  await Promise.all(
    tasks.map(async task => {
      const result = await task.promise;
      done++;
      results.value[`${task.code}|${task.ticker}`] = result.ok
        ? `✅ ${result.msg}`
        : `❌ ${result.msg}`;
      status.value = `正在购买（${done}/${total}）...`;
    }),
  );
  status.value = '完成';
  running.value = false;
}
</script>

<template>
  <div :class="$style.container">
    <SectionHeader>快捷买油</SectionHeader>
    <div :class="$style.autoBar">
      <label :class="$style.autoLabel">
        <input v-model="nx.enabled" type="checkbox" :class="$style.autoCheck" />
        自动补油：实时监听仓库油量，低于目标自动购买
      </label>
    </div>
    <table :class="$style.table">
      <thead>
        <tr>
          <th>空间站</th>
          <th>SF 当前</th>
          <th>SF 目标</th>
          <th>FF 当前</th>
          <th>FF 目标</th>
          <th>结果</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.code">
          <td :class="$style.station">{{ row.code }}</td>
          <td :class="$style.amount">{{ fixed0(row.sf) }}</td>
          <td>
            <input
              v-model.number="targetFor(row.code).sf"
              type="number"
              min="0"
              :class="$style.input"
              :disabled="running" />
          </td>
          <td :class="$style.amount">{{ fixed0(row.ff) }}</td>
          <td>
            <input
              v-model.number="targetFor(row.code).ff"
              type="number"
              min="0"
              :class="$style.input"
              :disabled="running" />
          </td>
          <td :class="$style.result">
            {{ results[`${row.code}|SF`] ?? results[`${row.code}|FF`] ?? '' }}
          </td>
        </tr>
      </tbody>
    </table>
    <div :class="$style.footer">
      <PrunButton primary :disabled="running || !hasAnyNeed" @click="buyAll">
        {{ running ? '购买中...' : '一键补油到目标' }}
      </PrunButton>
      <span v-if="status" :class="$style.status">{{ status }}</span>
    </div>
  </div>
</template>

<style module>
.container {
  padding: 4px;
  box-sizing: border-box;
}

.autoBar {
  padding: 4px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.autoLabel {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
  cursor: pointer;
}

.autoCheck {
  width: 14px;
  height: 14px;
  accent-color: #1a6a8a;
  cursor: pointer;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92em;
}

.table th,
.table td {
  padding: 4px 8px;
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.table th {
  opacity: 0.7;
  font-weight: normal;
  white-space: nowrap;
}

.station {
  font-weight: bold;
  color: var(--rp-color-accent-primary, #ffc856);
  white-space: nowrap;
}

.amount {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.input {
  width: 90px;
  background: #1a2632;
  color: #ccc;
  border: 1px solid #2b485a;
  padding: 2px 6px;
  font-size: 0.92em;
}

.input:focus {
  border-color: #3d6a8a;
  outline: none;
}

.result {
  font-size: 0.85em;
  white-space: nowrap;
}

.footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 4px 0;
}

.status {
  opacity: 0.8;
  font-size: 0.9em;
}
</style>
