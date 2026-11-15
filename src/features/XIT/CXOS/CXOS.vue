<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { cxosStore } from '@src/infrastructure/prun-api/data/cxos';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import SearchInput from '@src/components/forms/SearchInput.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import {
  deleteExchangeOrder,
  deleteExchangeOrderFromClick,
} from '@src/infrastructure/prun-ui/utils/delete-exchange-order';
import { showConfirmationOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { getPriceStep } from '@src/core/orders';
import { changeInputValue, clickElement } from '@src/utils/dom';
import { fixed0, fixed02, formatCurrency } from '@src/utils/format';
import { sleep } from '@src/utils/sleep';
import { getMaterialNameByTicker } from '@src/core/game-lookups';
import { isEmpty } from 'ts-extras';

const orders = computed(() => cxosStore.all.value);

// ── 筛选状态 ──
const statusFilters = ref(new Set<string>(['PLACED', 'PARTIALLY_FILLED']));
const exchangeFilter = ref<string | null>(null);
const materialSearch = ref('');

// ── 可用交易所列表 ──
const exchanges = computed(() => {
  const set = new Set<string>();
  if (!orders.value) {
    return [];
  }
  for (const o of orders.value) {
    set.add(o.exchange.code);
  }
  return [...set].sort((a, b) => getExchangeRank(a) - getExchangeRank(b));
});

// ── 交易所排序优先级 ──
const exchangeOrder: Record<string, number> = { IC1: 0, NC1: 1, AI1: 2, CI1: 3 };

function getExchangeRank(code: string) {
  return exchangeOrder[code] ?? 99;
}

interface OrderWithRank extends PrunApi.CXOrder {
  rank: string;
}

// ── 筛选 + 排序 + 排名后的订单 ──
const filteredOrders = computed<OrderWithRank[]>(() => {
  if (!orders.value) {
    return [];
  }
  const filtered = orders.value.filter(o => {
    if (!statusFilters.value.has(o.status)) {
      return false;
    }
    if (exchangeFilter.value && o.exchange.code !== exchangeFilter.value) {
      return false;
    }
    if (materialSearch.value) {
      const q = materialSearch.value.toUpperCase();
      if (!o.material.ticker.includes(q)) {
        return false;
      }
    }
    return true;
  });

  // 通过市场订单簿计算真实排名
  const brokers = cxobStore.all.value;
  const result: OrderWithRank[] = [];
  for (const o of filtered) {
    const withRank: OrderWithRank = { ...o, rank: '' };
    if (o.status === 'FILLED') {
      withRank.rank = '-';
      result.push(withRank);
      continue;
    }
    // 查找匹配的订单簿（同交易所 + 同 ticker）
    const broker = brokers?.find(
      b => b.exchange.code === o.exchange.code && b.material.ticker === o.material.ticker,
    );
    if (!broker) {
      withRank.rank = '?';
      result.push(withRank);
      continue;
    }
    const orders = o.type === 'SELLING' ? broker.sellingOrders : broker.buyingOrders;
    // 按限价排序：卖单从低到高，买单从高到低
    const sorted = [...orders].sort((a, b) => {
      const diff = a.limit.amount - b.limit.amount;
      return o.type === 'SELLING' ? diff : -diff;
    });
    const idx = sorted.findIndex(x => x.id === o.id);
    withRank.rank = idx >= 0 ? `#${idx + 1}` : '?';
    result.push(withRank);
  }

  // 按交易所优先级排序, 同交易所按材料代码排序
  return result.sort((a, b) => {
    const rankDiff = getExchangeRank(a.exchange.code) - getExchangeRank(b.exchange.code);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return a.material.ticker.localeCompare(b.material.ticker);
  });
});

// ── 统计 ──
const stats = computed(() => {
  const active = (orders.value ?? []).filter(o => o.status !== 'FILLED');
  // 按货币统计总金额 (amount * limit.amount)
  const byCurrency: Record<string, { total: number; count: number }> = {};
  for (const o of active) {
    const ccy = o.limit.currency;
    if (!(ccy in byCurrency)) {
      byCurrency[ccy] = { total: 0, count: 0 };
    }
    byCurrency[ccy].total += o.amount * o.limit.amount;
    byCurrency[ccy].count += 1;
  }

  let totalLeft = 0;
  let totalInitial = 0;
  for (const o of active) {
    totalLeft += o.amount;
    totalInitial += o.initialAmount;
  }

  return { active: active.length, byCurrency, totalLeft, totalInitial };
});

// ── 状态文本 & 样式类 ──
// cls 必须是 <style module> 里的类名键：CSS Modules 会把 .statusPlaced 编译成
// .rp-CXOS__statusPlaced___hash，早先这里写 'status-placed' 原始字符串、
// 模板又直接当普通 class 用，导致这五条颜色规则从未命中任何元素，
// 状态 / 买卖方向全是一个默认灰字。改成 $style[...] 取哈希后的真实类名。
const statusMap: Record<string, { label: string; cls: string }> = {
  PLACED: { label: '已挂单', cls: 'statusPlaced' },
  PARTIALLY_FILLED: { label: '部分成交', cls: 'statusPartial' },
  FILLED: { label: '已成交', cls: 'statusFilled' },
};

const typeMap: Record<string, { label: string; cls: string }> = {
  BUYING: { label: '买入', cls: 'typeBuying' },
  SELLING: { label: '卖出', cls: 'typeSelling' },
};

// 表格里金额显示：formatCurrency 默认用玩家主币符号，但订单实际货币可能是
// ICA/NCC/AIC/CIS 中任一种。混在一起显示会让玩家误以为是同一面额相加，
// 所以这里显式把订单实际的货币代码后缀上去。
function formatOrderAmount(value: number, currency: string): string {
  return `${fixed0(value)} ${currency}`;
}

// ── 一键加载市场排名 ──
const missingTickers = computed(() => {
  const brokers = cxobStore.all.value;
  if (!brokers) {
    return 0;
  }
  const loaded = new Set<string>();
  for (const b of brokers) {
    loaded.add(`${b.exchange.code}|${b.material.ticker}`);
  }
  return filteredOrders.value.filter(
    o => o.status !== 'FILLED' && !loaded.has(`${o.exchange.code}|${o.material.ticker}`),
  ).length;
});

const loadingRanks = ref(false);

async function loadAllRanks() {
  loadingRanks.value = true;
  const brokers = cxobStore.all.value ?? [];
  const loaded = new Set<string>();
  for (const b of brokers) {
    loaded.add(`${b.exchange.code}|${b.material.ticker}`);
  }

  const toLoad: { key: string; command: string }[] = [];
  for (const o of filteredOrders.value) {
    if (o.status === 'FILLED') {
      continue;
    }
    const key = `${o.exchange.code}|${o.material.ticker}`;
    if (loaded.has(key)) {
      continue;
    }
    loaded.add(key);
    toLoad.push({
      key,
      command: `CXOB ${o.material.ticker}.${o.exchange.code}`,
    });
  }
  if (toLoad.length === 0) {
    loadingRanks.value = false;
    return;
  }

  // 后台静默拉取：每个 ticker 开一块 CXOB 订单簿，服务器推回 COMEX_BROKER_DATA
  // 后由 closeWhen 自动关窗，玩家看不到任何窗口闪烁。
  const waiters: Promise<unknown>[] = [];
  for (const { key, command } of toLoad) {
    const [exchange, ticker] = key.split('|');
    const ready = computed(
      () =>
        cxobStore.all.value?.some(
          b => b.exchange.code === exchange && b.material.ticker === ticker,
        ) === true,
    );
    waiters.push(showBuffer(command, { autoClose: true, closeWhen: ready }));
  }
  await Promise.all(waiters);

  loadingRanks.value = false;
}

// ── 打开时自动加载实时价格 ──
// 首次挂载 / 重开时触发：等订单数据到位后跑一遍 loadAllRanks()。
// loadAllRanks 内部已做了「已加载的 ticker 跳过」的判断，所以即使上次
// 会话留下的 cxobStore 数据完整，本次不会重复开 CXOB 窗口。
onMounted(() => {
  watch(
    orders,
    o => {
      if (o && o.length > 0 && !loadingRanks.value) {
        void loadAllRanks();
      }
    },
    { immediate: true },
  );
});

// ── 切换筛选 ──
function toggleStatus(s: string) {
  const next = new Set(statusFilters.value);
  if (next.has(s)) {
    next.delete(s);
  } else {
    next.add(s);
  }
  statusFilters.value = next;
}

function openCxpo(ticker: string, exchange: string) {
  showBuffer(`CXPO ${ticker}.${exchange}`);
}

function onDeleteClick(event: MouseEvent, orderId: string) {
  deleteExchangeOrderFromClick(event, orderId, 'CXOS');
}

// ── 压价 ──
async function openCxpoTile(command: string) {
  // 后台静默打开：autoClose + closeWhen，窗口全程不可见
  const closeWhen = ref(false);
  const win = await showBuffer(command, { autoClose: true, closeWhen });
  return { win, closeWhen };
}

function poll<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const deadline = Date.now() + ms;
    const tick = async () => {
      const value = get();
      if (value !== undefined && value !== null) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        resolve(undefined);
        return;
      }
      await sleep(200);
      void tick();
    };
    void tick();
  });
}

function onPriceCut(event: MouseEvent, order: OrderWithRank) {
  if (order.type !== 'SELLING') {
    return;
  }
  const target = computeTargetPrice(order);
  if (target === undefined || target === null || Number.isNaN(target)) {
    return;
  }
  const displayPrice = fixed02(target);
  showConfirmationOverlay(
    event,
    () => {
      void runPriceCut(event.target as Element, order, target);
    },
    {
      message: `删除当前订单，并以 ${displayPrice} 压价重新挂单？`,
      confirmLabel: '压价',
    },
  );
}

// 计算目标压价：排除自己的订单，取当前最低卖价 - 步长
function computeTargetPrice(order: OrderWithRank) {
  const broker = cxobStore.all.value?.find(
    b => b.exchange.code === order.exchange.code && b.material.ticker === order.material.ticker,
  );
  if (!broker || broker.sellingOrders.length === 0) {
    return undefined;
  }
  const others = broker.sellingOrders.filter(o => o.id !== order.id);
  if (others.length === 0) {
    return undefined;
  }
  const lowest = Math.min(...others.map(o => o.limit.amount));
  const target = lowest - getPriceStep(lowest);
  return target > 0 ? target : undefined;
}

// ── 批量压价 ──
const batchRunning = ref(false);

// 当前筛选结果中的可压价卖单
const batchableOrders = computed(() =>
  filteredOrders.value.filter(o => o.type === 'SELLING' && o.status !== 'FILLED'),
);

// 选中的订单 id（仅卖单可选中）
const selectedIds = ref(new Set<string>());

const selectedOrders = computed(() =>
  filteredOrders.value.filter(o => selectedIds.value.has(o.id)),
);

const allSelected = computed(
  () =>
    batchableOrders.value.length > 0 &&
    batchableOrders.value.every(o => selectedIds.value.has(o.id)),
);

function toggleSelect(order: OrderWithRank) {
  if (order.type !== 'SELLING' || order.status === 'FILLED') {
    return;
  }
  const next = new Set(selectedIds.value);
  if (next.has(order.id)) {
    next.delete(order.id);
  } else {
    next.add(order.id);
  }
  selectedIds.value = next;
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(batchableOrders.value.map(o => o.id));
  }
}

async function batchPriceCut() {
  if (batchRunning.value) {
    return;
  }
  const sells = selectedOrders.value;
  if (sells.length === 0) {
    return;
  }

  batchRunning.value = true;
  const targetElement = document.querySelector(`.${C.TileFrame.body}`) ?? document.body;
  try {
    // 按 (交易所, 材料) 分组
    const groups = new Map<string, OrderWithRank[]>();
    for (const o of sells) {
      const key = `${o.exchange.code}|${o.material.ticker}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(o);
    }

    // 不同 (交易所, 材料) 组互相独立，并发压价；组内保持顺序（目标价链）。
    const tasks: Promise<void>[] = [];
    for (const [key, orders] of groups) {
      tasks.push(
        (async () => {
          const [exchange, ticker] = key.split('|');
          const broker = cxobStore.all.value?.find(
            b => b.exchange.code === exchange && b.material.ticker === ticker,
          );
          if (!broker) {
            return;
          }
          // 市场最低卖价（排除自己的所有订单）
          const myIds = new Set(orders.map(o => o.id));
          const others = broker.sellingOrders.filter(o => !myIds.has(o.id));
          if (others.length === 0) {
            return;
          }
          let currentLowest = Math.min(...others.map(o => o.limit.amount));

          // 组内按当前价格从低到高处理：第一个压到最低-1档，
          // 后续订单在前一个目标价基础上再压一档，保证依次霸榜前几名。
          const sorted = [...orders].sort((a, b) => a.limit.amount - b.limit.amount);
          for (const order of sorted) {
            const step = getPriceStep(currentLowest);
            const target = currentLowest - step;
            if (target <= 0) {
              continue;
            }
            currentLowest = target;
            await runPriceCut(targetElement, order, target);
          }
        })(),
      );
    }
    await Promise.all(tasks);
  } finally {
    batchRunning.value = false;
    selectedIds.value = new Set();
  }
}

async function runPriceCut(target: Element, order: OrderWithRank, targetPrice: number) {
  // 1. 删除旧订单（不带确认，压价已确认过）
  const deleted = await deleteExchangeOrder(target, order.id, 'CXOS', true);
  if (!deleted) {
    return;
  }
  // 2. 后台静默打开 CXPO 面板
  const { win, closeWhen } = await openCxpoTile(
    `CXPO ${order.material.ticker}.${order.exchange.code}`,
  );
  if (win === undefined || win === null) {
    return;
  }
  try {
    // 3. 轮询等待表单渲染
    const form = await poll(() => _$(win, C.ComExPlaceOrderForm.form), 8000);
    if (!form) {
      return;
    }
    // 4. 轮询等待输入框出现
    const inputs = await poll(() => {
      const list = _$$(form, 'input');
      return list.length >= 2
        ? [list[0] as HTMLInputElement, list[1] as HTMLInputElement]
        : undefined;
    }, 8000);
    if (!inputs) {
      return;
    }
    const [quantityInput, priceInput] = inputs;
    changeInputValue(quantityInput, fixed0(order.amount));
    changeInputValue(priceInput, fixed02(targetPrice));
    // 等待输入事件被 React 处理
    await sleep(200);
    // 5. 卖出按钮限定在按钮区内查找
    const buttonsField = form.children[12];
    if (buttonsField === undefined || buttonsField === null) {
      return;
    }
    const sellButton = _$(buttonsField, C.Button.danger);
    if (sellButton) {
      clickElement(sellButton);
    }
    // 给服务器留出处理时间后关闭后台窗口
    await sleep(1500);
  } finally {
    closeWhen.value = true;
  }
}
</script>

<template>
  <LoadingSpinner v-if="!orders" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- ═══ 统计栏 ═══ -->
    <div :class="$style.summaryBar">
      <span
        >活跃挂单 <b>{{ stats.active }}</b> 单</span
      >
      <span v-if="stats.totalLeft > 0">
        剩余 <b>{{ fixed0(stats.totalLeft) }}</b> / {{ fixed0(stats.totalInitial) }}
      </span>
      <span v-for="(v, ccy) in stats.byCurrency" :key="ccy">
        {{ ccy }} 总额: <b>{{ formatCurrency(v.total, fixed0) }}</b>
      </span>
    </div>

    <!-- ═══ 筛选栏 ═══ -->
    <div :class="$style.filterBar">
      <div :class="$style.statusGroup">
        <PrunButton
          v-for="s in ['PLACED', 'PARTIALLY_FILLED']"
          :key="s"
          :primary="statusFilters.has(s)"
          :neutral="!statusFilters.has(s)"
          inline
          @click="toggleStatus(s)">
          {{ statusMap[s].label }}
        </PrunButton>
      </div>
      <PrunButton
        v-if="missingTickers > 0"
        dark
        inline
        :disabled="loadingRanks"
        @click="loadAllRanks">
        {{ loadingRanks ? '加载中…' : `加载排名 (${missingTickers})` }}
      </PrunButton>
      <PrunButton dark inline :primary="allSelected" @click="toggleSelectAll">
        {{ allSelected ? '取消全选' : '全选' }}
      </PrunButton>
      <PrunButton
        danger
        inline
        :disabled="batchRunning || selectedOrders.length === 0"
        @click="batchPriceCut">
        {{ batchRunning ? '压价中…' : `批量压价 (${selectedOrders.length})` }}
      </PrunButton>
      <div :class="$style.filterGroup">
        <label :class="$style.filterLabel">交易所</label>
        <select v-model="exchangeFilter" :class="$style.select">
          <option :value="null">全部</option>
          <option v-for="ex in exchanges" :key="ex" :value="ex">{{ ex }}</option>
        </select>
      </div>
      <div :class="$style.filterGroup">
        <label :class="$style.filterLabel">材料</label>
        <SearchInput v-model="materialSearch" :class="$style.searchInput" placeholder="搜索代码…" />
      </div>
    </div>

    <!-- ═══ 订单表格 ═══ -->
    <table>
      <thead>
        <tr>
          <th>选择</th>
          <th>材料</th>
          <th>类型</th>
          <th>交易所</th>
          <th>数量</th>
          <th>限价</th>
          <th>排名</th>
          <th>总价</th>
          <th>状态</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(filteredOrders)">
          <td colspan="10" :class="$style.empty">没有匹配的挂单</td>
        </tr>
        <tr
          v-for="order in filteredOrders"
          :key="order.id"
          :class="[order.status === 'FILLED' && $style.filledRow]">
          <!-- 选择 -->
          <td>
            <input
              type="checkbox"
              :checked="selectedIds.has(order.id)"
              :disabled="order.type !== 'SELLING' || order.status === 'FILLED'"
              @change="toggleSelect(order)" />
          </td>
          <!-- 材料图标 + 中文名 -->
          <td>
            <div :class="$style.materialCell">
              <MaterialIcon :ticker="order.material.ticker" size="small" compact />
              <span
                :class="$style.tickerLink"
                @click="openCxpo(order.material.ticker, order.exchange.code)">
                {{ getMaterialNameByTicker(order.material.ticker) ?? order.material.ticker }}
              </span>
            </div>
          </td>
          <!-- 类型 -->
          <td :class="$style[typeMap[order.type].cls]">
            {{ typeMap[order.type].label }}
          </td>
          <!-- 交易所 -->
          <td>{{ order.exchange.code }}</td>
          <!-- 数量进度 -->
          <td>
            <div :class="$style.amountCell">
              <span>{{ fixed0(order.amount) }} / {{ fixed0(order.initialAmount) }}</span>
              <div :class="$style.progressTrack">
                <div
                  :class="$style.progressFill"
                  :style="{
                    width:
                      Math.round((order.amount / Math.max(order.initialAmount, 1)) * 100) + '%',
                  }" />
              </div>
            </div>
          </td>
          <!-- 限价 -->
          <td :class="$style.number">
            {{ formatOrderAmount(order.limit.amount, order.limit.currency) }}
          </td>
          <!-- 排名 -->
          <td :class="[$style.number, $style.rankCell]">
            {{ order.rank }}
          </td>
          <!-- 总价 -->
          <td :class="$style.number">
            {{ formatOrderAmount(order.amount * order.limit.amount, order.limit.currency) }}
          </td>
          <!-- 状态 -->
          <td :class="[$style[statusMap[order.status].cls], $style.statusCell]">
            {{ statusMap[order.status].label }}
          </td>
          <!-- 操作 -->
          <td :class="$style.actionCell">
            <PrunButton
              v-if="order.status !== 'FILLED'"
              dark
              inline
              @click="(e: MouseEvent) => onDeleteClick(e, order.id)">
              删除
            </PrunButton>
            <PrunButton
              v-if="order.type === 'SELLING' && order.status !== 'FILLED'"
              danger
              inline
              @click="(e: MouseEvent) => onPriceCut(e, order)">
              压价
            </PrunButton>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style module>
.container {
  padding: 4px;
  box-sizing: border-box;
}

.container table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

/* ── 统计栏 ── */
/* 统计栏回到基准字号且不压透明度：原先 0.9em(≈9.9px) 再叠 0.85 透明，
   浅色主题下数字又小又淡。强调数字的颜色由不带字面量的变量保证。 */
.summaryBar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 4px 8px;
  font-size: calc(0.9em + 0.1em * var(--rp-font-enlargement));
}

/* 强调文字（统计数字 / 材料名 / 排名）不能用 --rp-color-accent-primary：
   主题引擎会把 refined-prun.css 里 html{--rp-color-accent-primary:#ffc856}
   连变量定义一起重映射，自定义主题下它变成 #e7eef4 近白色，浅底上对比度
   只有约 1.0，几乎看不见。改用 --rp-skin-selection（light 深石板蓝 #33566f、
   暖米纸深棕 #9b6b2f，主题引擎不会重刷这组变量）；default「原样」主题没有
   这组变量，回退到原来的琥珀黄，仍是深底亮字。整条声明只写 var()、不含颜色
   字面量，主题引擎的 COLOR_RE 扫描会跳过，不会被二次改写。 */
.summaryBar b {
  color: var(--rp-skin-selection, var(--rp-color-accent-primary));
}

/* 以下两处（材料名链接、排名）同理，只引用变量、不写颜色字面量。 */

/* ── 可读性：颜色一律走三套自定义主题都定义了的 --rp-skin-* token ──────
   上一轮全库筛查发现 CXOS 还留着一批游戏深底时代的硬编码色（#1a2632 /
   #ccc / #5bc0de / …）和 0.75~0.85 的低不透明度。硬编码色只能靠主题引擎
   CSSOM 扫描重映射兜底，碰到扫描顺序 / 组件后注入的样式表就会失效；低
   opacity 在浅底上又会把文字冲淡。统一改成与 NX.vue 相同的写法：
   var(--rp-skin-*, <原深底色回退>)。自定义主题取主题的深色 token，
   default「原样」主题没有这组变量，回退值仍是原来的深底亮字，两套都可读。
   回退里虽含颜色字面量会被主题引擎扫描，但自定义主题下变量一定存在、
   回退不参与计算，因此不影响结果。 */

/* ── 筛选栏 ── */
.filterBar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--rp-skin-border, rgba(255, 255, 255, 0.08));
}

.statusGroup {
  display: flex;
  gap: 4px;
}

.filterGroup {
  display: flex;
  align-items: center;
  gap: 4px;
}

.filterLabel {
  font-size: calc(0.85em + 0.15em * var(--rp-font-enlargement));
  color: var(--rp-skin-ink, #ccc);
}

.select {
  background: var(--rp-skin-input-bg, #1a2632);
  color: var(--rp-skin-ink, #ccc);
  border: 1px solid var(--rp-skin-border, #2b485a);
  padding: 2px 6px;
  font-size: calc(0.85em + 0.15em * var(--rp-font-enlargement));
}

.searchInput {
  background: var(--rp-skin-input-bg, #1a2632);
  color: var(--rp-skin-ink, #ccc);
  border: 1px solid var(--rp-skin-border, #2b485a);
  padding: 2px 6px;
  font-size: calc(0.85em + 0.15em * var(--rp-font-enlargement));
  width: 90px;
}

.searchInput::placeholder {
  color: var(--rp-skin-muted, #999);
  opacity: 1;
}

/* ── 材料 ── */
.materialCell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tickerLink {
  cursor: pointer;
  color: var(--rp-skin-selection, var(--rp-color-accent-primary));
}

.tickerLink:hover {
  text-decoration: underline;
}

/* ── 数量 ── */
.amountCell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: calc(0.85em + 0.15em * var(--rp-font-enlargement));
  white-space: nowrap;
}

.progressTrack {
  width: 80px;
  height: 4px;
  background: var(--rp-skin-panel-strong, #1a2632);
  border: 1px solid var(--rp-skin-border, #1a2632);
  border-radius: 2px;
  overflow: hidden;
  box-sizing: border-box;
}

.progressFill {
  height: 100%;
  background: var(--rp-skin-selection, #337ab7);
  border-radius: 2px;
  transition: width 0.3s;
}

.number {
  text-align: right;
  white-space: nowrap;
}

.rankCell {
  color: var(--rp-skin-selection, var(--rp-color-accent-primary));
  font-weight: bold;
}

/* ── 状态 / 买卖方向 ──
   颜色取主题里「深色语义 token」：light 是低饱和深蓝 / 棕 / 墨绿 / 暗红，
   paper 是对应的暖调深色，ceramic 由 theme-ceramic.ts 把 --rp-skin-action-*
   映射到自己的色带文字色；default「原样」没有这些变量，回退到原先的亮色，
   正好适配深底。全部避开 --rp-color-accent-primary（会被主题引擎重映射成近白）。
   不再用 opacity 压淡，低对比度文字在浅底上会糊掉。
   五类各占一个色相，互不相同：已挂单=蓝、部分成交=棕橙、已成交=靛紫、
   买入=墨绿、卖出=暗红。状态用冷/中性色、买卖方向用红绿，避免「已成交」
   和「买入」以前共用 action-flight 撞成同一个绿色。 */
.statusCell {
  white-space: nowrap;
}

.statusPlaced {
  color: var(--rp-skin-eta, #5bc0de);
}

.statusPartial {
  color: var(--rp-skin-action-unload, #f0ad4e);
}

.statusFilled {
  color: var(--rp-skin-action-done, #b39ddb);
}

/* ── 类型 ── */
.typeBuying {
  color: var(--rp-skin-action-flight, #5cb85c);
  white-space: nowrap;
}

.typeSelling {
  color: var(--rp-skin-action-fuel, #d9534f);
  white-space: nowrap;
}

/* ── 已成交行：不用 opacity 做退后感，改用主题的次要文字色 ── */
.filledRow {
  color: var(--rp-skin-muted, #999);
}

/* ── 操作 ── */
.actionCell {
  text-align: center;
  white-space: nowrap;
}

/* ── 选中复选框 ── */
.container input[type='checkbox'] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  margin: 0;
  padding: 0;
  background: var(--rp-skin-input-bg, #0d1a24);
  border: 1px solid var(--rp-skin-border, #2b485a);
  border-radius: 2px;
  cursor: pointer;
  position: relative;
  vertical-align: middle;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.container input[type='checkbox']:hover {
  border-color: var(--rp-skin-border-strong, #3d6a8a);
}

.container input[type='checkbox']:checked {
  background: var(--rp-skin-selection, #1a6a8a);
  border-color: var(--rp-skin-selection, #2b7a9a);
}

.container input[type='checkbox']:checked::after {
  content: '✓';
  /* 选中块在自定义主题下是深色，勾必须浅；--rp-skin-bg 是页面浅底色。
     default 主题无此变量，回退到原来的浅蓝字（深底上同样清晰）。 */
  color: var(--rp-skin-bg, #d8ecf5);
  font-size: 11px;
  font-weight: bold;
  line-height: 1;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.container input[type='checkbox']:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 禁用态按钮（未选中订单时的「批量压价 (0)」）在游戏原生皮肤里是
   --rp-skin-disabled #98a3ac，浅底上只有 2.31:1，连按钮写什么都读不出来。
   WCAG 虽豁免 inactive 控件，但这里仍把文字提到主题次要色（light #4a5863，
   约 7:1），禁用感交给原有的浅底/浅边框表达。只作用于 CXOS 容器，
   不影响其它窗口的禁用按钮；选择器带 html[data-rp-theme] + 容器类，
   特异性高于 CONTROL_CSS 的全局 disabled 规则。 */
html[data-rp-theme] .container button:disabled,
html[data-rp-theme] .container [class*='Button__btn'][class*='Button__disabled'] {
  color: var(--rp-skin-muted, #999) !important;
  -webkit-text-fill-color: var(--rp-skin-muted, #999) !important;
}

/* ── 空状态 ── */
.empty {
  text-align: center;
  color: var(--rp-skin-muted, #999);
  padding: 12px;
}
</style>
