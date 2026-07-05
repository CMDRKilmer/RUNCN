<script setup lang="ts">
import { watch, reactive } from 'vue';
import { cxosStore } from '@src/infrastructure/prun-api/data/cxos';
import DateRow from '@src/features/XIT/CXTS/DateRow.vue';
import TradeRow from '@src/features/XIT/CXTS/TradeRow.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { isEmpty } from 'ts-extras';
import { clamp } from '@src/utils/clamp';

const orders = computed(() => cxosStore.all.value);

type Granularity = 'daily' | 'weekly' | 'monthly';

const granularity = ref<Granularity>('daily');

interface OrderTrade {
  order: PrunApi.CXOrder;
  trade: PrunApi.CXTrade;
  date: number;
}

interface DayTrades {
  date: number;
  trades: OrderTrade[];
  totals: { [currency: string]: { purchases: number; sales: number } };
}

const days = computed(() => {
  const trades: OrderTrade[] = [];
  for (const order of orders.value!) {
    for (const trade of order.trades) {
      trades.push({
        order,
        trade,
        date: trade.time.timestamp,
      });
    }
  }
  trades.sort((a, b) => b.date - a.date);
  const days: DayTrades[] = [];
  if (isEmpty(trades)) {
    return days;
  }

  let day: DayTrades = {
    date: getDateComponent(trades[0].date),
    trades: [],
    totals: {},
  };
  days.push(day);

  for (const trade of trades) {
    if (trade.date < day.date) {
      day = {
        date: getDateComponent(trade.date),
        trades: [],
        totals: {},
      };
      days.push(day);
    }

    day.trades.push(trade);
    const currency = trade.trade.price.currency;
    const total = trade.trade.price.amount * trade.trade.amount;
    const totals = (day.totals[currency] ??= { purchases: 0, sales: 0 });
    if (trade.order.type === 'SELLING') {
      totals.sales += total;
    } else {
      totals.purchases += total;
    }
  }
  return days;
});

function getDateComponent(dateTime: number) {
  switch (granularity.value) {
    case 'weekly': {
      const d = new Date(dateTime);
      const diff = d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1);
      d.setDate(diff);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'monthly': {
      const d = new Date(dateTime);
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    }
    default: {
      return new Date(new Date(dateTime).toDateString()).getTime();
    }
  }
}

const daysToRender = ref(1);
let id = 0;

const expandedGroups = reactive<Record<number, boolean | undefined>>({});

watch(granularity, () => {
  daysToRender.value = 1;
  Object.keys(expandedGroups).forEach(key => delete expandedGroups[Number(key)]);
});

function stepRender() {
  id = requestAnimationFrame(stepRender);
  if (!orders.value) {
    daysToRender.value = 1;
  } else {
    daysToRender.value = clamp(daysToRender.value + 1, 0, days.value.length);
  }
}

onBeforeUnmount(() => cancelAnimationFrame(id));
stepRender();
</script>

<template>
  <LoadingSpinner v-if="orders === undefined" />
  <template v-else>
    <div :class="$style.controls">
      <PrunButton
        :neutral="granularity !== 'daily'"
        :primary="granularity === 'daily'"
        @click="granularity = 'daily'">
        每日
      </PrunButton>
      <PrunButton
        :neutral="granularity !== 'weekly'"
        :primary="granularity === 'weekly'"
        @click="granularity = 'weekly'">
        每周
      </PrunButton>
      <PrunButton
        :neutral="granularity !== 'monthly'"
        :primary="granularity === 'monthly'"
        @click="granularity = 'monthly'">
        每月
      </PrunButton>
    </div>
    <table>
      <thead>
        <tr>
          <th>时间</th>
          <th>类型</th>
          <th>代码</th>
          <th>对方</th>
          <th>数量</th>
          <th>价格</th>
          <th>总计</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(days)">
          <td colSpan="7">没有近期交易</td>
        </tr>
        <template v-else>
          <template v-for="group in daysToRender" :key="days[group - 1].date">
            <DateRow
              :date="days[group - 1].date"
              :totals="days[group - 1].totals"
              :hide-totals="days[group - 1].trades.length === 1"
              :granularity="granularity"
              :expanded="expandedGroups[days[group - 1].date] === true"
              @update:expanded="expandedGroups[days[group - 1].date] = $event" />
            <template v-if="expandedGroups[days[group - 1].date]">
              <TradeRow
                v-for="trade in days[group - 1].trades"
                :key="trade.trade.id"
                :date="trade.date"
                :order="trade.order"
                :trade="trade.trade" />
            </template>
          </template>
        </template>
      </tbody>
    </table>
  </template>
</template>

<style module>
.controls {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
</style>
