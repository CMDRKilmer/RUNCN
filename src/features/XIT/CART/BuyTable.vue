<script setup lang="ts">
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunLink from '@src/components/PrunLink.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0, fixed2 } from '@src/utils/format';
import { userData } from '@src/store/user-data';
import { getTileState } from '@src/store/user-data-tiles';
import { getWarehouseName } from '@src/features/XIT/CART/cart-utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { getPlanetBurn, type MaterialBurn } from '@src/core/burn';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { computeComponents, computeTotals, type BpcExchange } from '../BPC/bp-utils';

const cart = computed(() => userData.cart);
const parameters = useXitParameters();

// XIT CBUY <星球编码>：BURN 比价模式。清单来自该星球消耗品报告的「需要」列，
// 是临时计算，不读写 userData.cart，所以不会覆盖用户在 XIT CART 里维护的清单。
// 不带参数时走原来的购物车比价，行为完全不变。
const burnNaturalId = computed(() => parameters[0] ?? '');
const burnMode = computed(() => burnNaturalId.value !== '');
const burnSite = computed(() =>
  burnMode.value ? sitesStore.getByPlanetNaturalIdOrName(burnNaturalId.value) : undefined,
);
const planetBurn = computed(() => getPlanetBurn(burnSite.value?.siteId));
const burnLoading = computed(() => burnMode.value && planetBurn.value === undefined);

// 与 BURN/MaterialRow.vue 的 needAmt 保持同一口径：补足到补给天数所需数量。
function burnNeedAmount(mat: MaterialBurn, resupply: number) {
  const days = mat.dailyAmount >= 0 ? 1000 : mat.daysLeft;
  if (days > resupply || mat.dailyAmount > 0) {
    return 0;
  }
  const need = Math.ceil((days - resupply) * mat.dailyAmount);
  return need === 0 ? 0 : need;
}

const burnNeeds = computed(() => {
  const burn = planetBurn.value;
  if (!burnMode.value || !burn) {
    return [];
  }
  const resupply = userData.settings.burn.resupply;
  return Object.entries(burn.burn)
    .map(([ticker, mat]) => ({
      ticker,
      name: ticker,
      amount: burnNeedAmount(mat, resupply),
    }))
    .filter(item => Number.isFinite(item.amount) && item.amount > 0)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
});

// 购物车物品即购买表的需求清单（同一 ticker 在 CART 内已合并）。
const cartNeeds = computed(() =>
  cart.value.items
    .filter(item => item.ticker && Number.isFinite(item.amount) && item.amount > 0)
    .map(item => ({
      ticker: item.ticker,
      name: item.ticker,
      amount: item.amount,
    })),
);

const needs = computed(() => (burnMode.value ? burnNeeds.value : cartNeeds.value));

// 比价模式下生成的 ACT 包 / CONTGEN 清单用独立名字，避免覆盖购物车那份。
const listName = computed(() => (burnMode.value ? `BURN ${burnNaturalId.value}` : cart.value.name));

const selectedTickers = ref<Set<string>>(new Set());

// 硬编码 4 个玩家 CX 交易所（与 BPC/BMAT/ARB 一致），避免运行时依赖 exchangesStore。
const exchanges: BpcExchange[] = [
  { code: 'AI1', currency: 'AIC' },
  { code: 'CI1', currency: 'CIS' },
  { code: 'IC1', currency: 'ICA' },
  { code: 'NC1', currency: 'NCC' },
];

const components = computed(() => computeComponents(needs.value, exchanges));
const totals = computed(() => computeTotals(components.value, exchanges, selectedTickers.value));

// 价格只来自游戏内实时订单簿（CXOB 推送），不连接 FIO 网站。
// 原先用 `!cxStore.fetched` 拦住整张表，但 FIO 聚合价并不参与 readBuyPrice()，
// 这个门槛只会让表格被一个无关的网络请求挡住，已移除。
const noItems = computed(() => needs.value.length === 0);

function openCart() {
  showBuffer('XIT CART');
}

function toggleTicker(ticker: string) {
  const next = new Set(selectedTickers.value);
  if (next.has(ticker)) {
    next.delete(ticker);
  } else {
    next.add(ticker);
  }
  selectedTickers.value = next;
}

function toggleAll() {
  if (allSelected.value) {
    selectedTickers.value = new Set();
  } else {
    selectedTickers.value = new Set(components.value.map(c => c.ticker));
  }
}

const allSelected = computed(
  () =>
    components.value.length > 0 && components.value.every(c => selectedTickers.value.has(c.ticker)),
);
const partialSelected = computed(
  () => !allSelected.value && components.value.some(c => selectedTickers.value.has(c.ticker)),
);

// 已选物品（按 ticker 去重），按全市场最优交易所分组。
// 返回值：exchangeCode -> { ticker: amount }。
const selectedByExchange = computed(() => {
  const groups = new Map<string, Record<string, number>>();
  for (const c of components.value) {
    if (!selectedTickers.value.has(c.ticker) || c.bestExchange === undefined) {
      continue;
    }
    const bucket = groups.get(c.bestExchange) ?? {};
    bucket[c.ticker] = (bucket[c.ticker] ?? 0) + c.amount;
    groups.set(c.bestExchange, bucket);
  }
  return groups;
});

// ACT 生成选项。默认单市场：选中最便宜且凑齐全部物品的交易所整单购买。
// singleMarketMode=false 时按各物品最优价分市场购买（最优混合），由顶部
// 「分市场购买」复选框控制。
const singleMarketMode = ref(true);
// '' = 用最优市场；指定交易所代码则强制用该市场，即使它不是最优（就近采购）。
const forcedExchange = ref('');
const transferToShip = ref(false);

// 复选框与卡片选中互为反向，两个控件状态永远一致：点卡片会自动取消勾选，
// 勾选「分市场购买」后所有卡片橙框消失、只作比价参考。
const splitMarketMode = computed({
  get: () => !singleMarketMode.value,
  set: (value: boolean) => {
    singleMarketMode.value = !value;
  },
});

const cheapestSingleExchange = computed(() => totals.value.cheapestSingle?.code);
const chosenSingleExchange = computed(() =>
  singleMarketMode.value ? forcedExchange.value || cheapestSingleExchange.value : undefined,
);

// 卡片右上角角标：最优市场标「最优」，其余标相对最优的价差（1:1 口径，不换算
// 汇率）；没凑齐全部物品的市场总价不可比，改标缺报价数，避免出现负差价。
function exchangeBadge(et: (typeof totals.value.exchanges)[number]) {
  const best = totals.value.cheapestSingle;
  if (best && et.code === best.code) {
    return { text: '最优', kind: 'best' as const };
  }
  if (!et.complete) {
    return { text: `缺 ${et.missing} 种`, kind: 'warn' as const };
  }
  if (best) {
    return { text: `+${fixed0(et.total - best.total)}`, kind: 'diff' as const };
  }
  return undefined;
}

// 点击卡片选定该交易所；再点一次当前已选中的卡片则取消单市场，回到最优混合。
function pickExchange(code: string) {
  if (singleMarketMode.value && chosenSingleExchange.value === code) {
    singleMarketMode.value = false;
    forcedExchange.value = '';
    return;
  }
  singleMarketMode.value = true;
  forcedExchange.value = code;
}

// 按"单市场"或"混合最优"分组的 selectedByExchange。
// 没有任何市场凑齐全部物品时（cheapestSingle 为空）自动退回混合，保证 ACT 仍可生成。
const actGroups = computed(() => {
  const code = singleMarketMode.value ? chosenSingleExchange.value : undefined;
  if (code) {
    const bucket: Record<string, number> = {};
    for (const c of components.value) {
      if (!selectedTickers.value.has(c.ticker)) {
        continue;
      }
      bucket[c.ticker] = (bucket[c.ticker] ?? 0) + c.amount;
    }
    return new Map([[code, bucket]]);
  }
  return selectedByExchange.value;
});

const canGenerateActOptions = computed(() => actGroups.value.size > 0);

// 与 BPC/BMAT 一致的 ASCII 净化：XIT 参数仅吃 ASCII。
function asciiSafe(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateAct() {
  if (actGroups.value.size === 0) {
    return;
  }
  const groups: UserData.MaterialGroupData[] = [];
  const actions: UserData.ActionData[] = [];
  for (const [exchangeCode, materials] of actGroups.value) {
    const groupName = `CBUY_${exchangeCode}`;
    groups.push({ type: 'Manual', name: groupName, materials });
    actions.push({
      type: 'CX Buy',
      name: `Buy_${exchangeCode}`,
      group: groupName,
      exchange: exchangeCode,
      priceLimits: {},
      buyPartial: false,
      allowUnfilled: false,
      useCXInv: true,
    });
    if (!transferToShip.value) {
      continue;
    }
    actions.push({
      type: 'MTRA',
      name: `Transfer_${exchangeCode}`,
      group: groupName,
      origin: getWarehouseName(exchangeCode),
      dest: configurableValue,
    });
  }
  // 包名用清单名 + " Buy" 后缀，避免与 CART 生成的同名 ACT 包互相覆盖。
  const asciiName = asciiSafe(listName.value);
  const name = asciiName ? `${asciiName} Buy` : 'Shopping Cart Buy';
  const pkg: UserData.ActionPackageData = { global: { name }, groups, actions };
  const existing = userData.actionPackages.findIndex(p => p.global.name === name);
  if (existing >= 0) {
    userData.actionPackages[existing] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
  const commandName = name.replace(/\s+/g, '_');
  showBuffer(`XIT ACT_${commandName}`);
}

// 把当前已选物品（未选则全部）以顶层 materials 形态发给 CONTGEN 起草合同。
function sendToContgen() {
  if (components.value.length === 0) {
    return;
  }
  const tickersToSend =
    selectedTickers.value.size > 0
      ? new Set(selectedTickers.value)
      : new Set(components.value.map(c => c.ticker));
  const materials: Record<string, number> = {};
  for (const c of components.value) {
    if (!tickersToSend.has(c.ticker)) {
      continue;
    }
    materials[c.ticker] = (materials[c.ticker] ?? 0) + c.amount;
  }
  if (Object.keys(materials).length === 0) {
    return;
  }
  const payload: { materials: Record<string, number>; name?: string } = { materials };
  const asciiName = asciiSafe(listName.value);
  if (asciiName.length > 0) {
    payload.name = asciiName;
  }
  const ws = getTileState<{ json?: string }>('contgen-import');
  ws.json = JSON.stringify(payload);
  showBuffer('XIT CONTGEN');
}

const canSendToContgen = computed(() => components.value.length > 0);

// ── 实时盘口订阅（与 BPC/BMAT 同一套机制）──────────────────────────
// showBuffer('CXOB <ticker>.<exchange>', { autoClose: true }) 会新建一个隐藏
// 窗口（buffers.ts 给它加 hidden 类、隐藏 dock 按钮），游戏服务器随之推送
// COMEX_BROKER_DATA 到 cxobStore；数据到达后窗口自动关闭。
// bp-utils.readBuyPrice() 只读这份游戏内订单簿，与 FIO 网站无关。
function openCxob(key: string, timedOut?: Ref<boolean>) {
  void showBuffer(`CXOB ${key}`, {
    autoClose: true,
    closeWhen: computed(() => cxobStore.getByTicker(key) !== undefined || timedOut?.value === true),
  });
}

function pendingCxobKeys() {
  const keys = new Set<string>();
  for (const need of needs.value) {
    for (const exchange of exchanges) {
      const key = `${need.ticker}.${exchange.code}`;
      if (cxobStore.getByTicker(key) === undefined) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

// 手动「更新价格」：行为与原来一致，只补当前缺失的订单簿。
function refreshPrices() {
  for (const key of pendingCxobKeys()) {
    openCxob(key);
  }
}

// 「比价」模式打开即自动订阅，不需要再点一次按钮。
// 分批推入 showBuffer 的全局串行队列：一次性排满几十个请求会把用户手动开的
// 缓冲窗堵在队尾。没有订单簿的物品服务器不会推数据，用超时兜底关掉隐藏窗口。
const autoStarted = ref(false);
const autoTimedOut = shallowRef(false);
const disposed = ref(false);
let autoTimer: number | undefined;

async function autoRefreshPrices() {
  if (autoStarted.value) {
    return;
  }
  autoStarted.value = true;
  const keys = pendingCxobKeys();
  if (keys.length === 0) {
    return;
  }
  autoTimedOut.value = false;
  autoTimer = window.setTimeout(() => (autoTimedOut.value = true), 60000);
  for (let i = 0; i < keys.length && !disposed.value; i += 6) {
    for (const key of keys.slice(i, i + 6)) {
      if (cxobStore.getByTicker(key) === undefined) {
        openCxob(key, autoTimedOut);
      }
    }
    await new Promise(resolve => window.setTimeout(resolve, 600));
  }
}

onMounted(() => {
  watch(
    () => burnMode.value && needs.value.length > 0,
    ready => {
      if (ready) {
        void autoRefreshPrices();
      }
    },
    { immediate: true },
  );
  // 比价（XIT CBUY <星球>）默认按整份补给清单计算。原组件的勾选框默认全空，
  // 而「最优混合总价 / 最便宜单交易所 / 生成 ACT」都只算已选物品，不初始化就恒为 0。
  // 按清单内容初始化一次：之后用户手动取消勾选（哪怕清空）都不会被强行拉回；
  // 换成另一个星球、清单变了才重新全选。直接输 XIT CBUY 的购物车模式完全不参与。
  let initializedFor = '';
  watch(
    () => (burnMode.value ? components.value.map(c => c.ticker).join('|') : ''),
    key => {
      if (!burnMode.value || !key || initializedFor === key) {
        return;
      }
      selectedTickers.value = new Set(components.value.map(c => c.ticker));
      initializedFor = key;
    },
    { immediate: true },
  );
});

onUnmounted(() => {
  disposed.value = true;
  if (autoTimer !== undefined) {
    window.clearTimeout(autoTimer);
  }
  // 组件关掉后不再需要盘口：让还没等到数据的隐藏窗口也走 closeWhen 关闭，
  // 避免留下无人认领的空壳。
  autoTimedOut.value = true;
});

const priceProgress = computed(() => {
  if (!burnMode.value) {
    return undefined;
  }
  const total = needs.value.length * exchanges.length;
  let done = 0;
  for (const need of needs.value) {
    for (const exchange of exchanges) {
      if (cxobStore.getByTicker(`${need.ticker}.${exchange.code}`) !== undefined) {
        done++;
      }
    }
  }
  return { done, total };
});

function localized(component: { ticker: string; name: string }): string {
  const material = materialsStore.getByTicker(component.ticker);
  return getMaterialName(material) ?? component.name ?? component.ticker;
}

const search = ref('');

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) {
    return components.value;
  }
  return components.value.filter(c =>
    `${c.ticker} ${c.name} ${localized(c)}`.toLowerCase().includes(query),
  );
});

function priceOf(
  component: { prices: Map<string, { price: number; amount: number; live: boolean }> },
  code: string,
) {
  return component.prices.get(code);
}

function currencyOf(code: string): string {
  return exchanges.find(x => x.code === code)?.currency ?? '';
}

function isBest(component: { bestExchange?: string }, code: string) {
  return component.bestExchange === code;
}
</script>

<template>
  <div :class="$style.page">
    <div :class="$style.controls">
      <span :class="$style.controlLabel">{{ burnMode ? '比价来源' : '购物车' }}</span>
      <span :class="$style.cartMeta">
        <template v-if="burnMode">
          <strong>XIT BURN {{ burnNaturalId }}</strong> · {{ needs.length }} 种需补物资
        </template>
        <template v-else>
          <strong>{{ cart.name }}</strong>
          <template v-if="cart.exchange"> · {{ cart.exchange }}</template>
          · {{ cart.items.length }} 种
        </template>
      </span>
      <input
        id="cbu-search"
        v-model="search"
        name="cbu-search"
        :class="$style.input"
        type="text"
        placeholder="搜索物品 ticker 或名称" />
      <PrunButton primary :disabled="noItems" @click="refreshPrices">更新价格</PrunButton>
      <label
        :class="$style.control"
        data-tooltip="按各物品最优价分市场采购；不勾选则按选中卡片的交易所整单购买"
        data-tooltip-position="bottom">
        <input
          id="cbu-split-market"
          v-model="splitMarketMode"
          name="cbu-split-market"
          type="checkbox" />
        <span :class="$style.controlLabel">分市场购买</span>
      </label>
      <label :class="$style.control">
        <input
          id="cbu-transfer-ship"
          v-model="transferToShip"
          name="cbu-transfer-ship"
          type="checkbox" />
        <span :class="$style.controlLabel">转移到飞船</span>
      </label>
      <PrunButton primary :disabled="!canGenerateActOptions" @click="generateAct"
        >生成 ACT</PrunButton
      >
      <PrunButton
        primary
        :disabled="!canSendToContgen"
        data-tooltip="把当前已选物品清单发送到 CONTGEN 用于起草合同"
        data-tooltip-position="top"
        @click="sendToContgen"
        >导入到 CONTGEN</PrunButton
      >
    </div>

    <div v-if="burnMode && !burnSite" :class="$style.empty">
      找不到星球 {{ burnNaturalId }}，无法生成比价清单。
    </div>
    <div v-else-if="burnLoading" :class="$style.empty">
      正在加载 {{ burnNaturalId }} 的消耗品数据，请稍候…
    </div>
    <div v-else-if="noItems" :class="$style.empty">
      <template v-if="burnMode">
        {{ burnNaturalId }} 当前没有需要补给的消耗品（按补给天数过滤）。
      </template>
      <template v-else>
        购物车是空的。请先到
        <PrunButton dark inline @click="openCart">XIT CART</PrunButton>
        添加要购买的物品。
      </template>
    </div>
    <template v-else>
      <div :class="$style.summaryBar">
        <span :class="$style.summaryItem">
          物品 ·
          <strong>{{ components.length }}</strong> 种
          <span v-if="selectedTickers.size > 0" :class="$style.summaryProfit">
            · 已选 <strong>{{ selectedTickers.size }}</strong> 种</span
          >
          <span v-if="totals.mixedMissing > 0" :class="$style.summaryWarn">
            · {{ totals.mixedMissing }} 种无报价</span
          >
        </span>
        <span :class="$style.summaryItem">
          最便宜单交易所 ·
          <strong v-if="totals.cheapestSingle">
            {{ totals.cheapestSingle.code }}
            {{ fixed0(totals.cheapestSingle.total) }}
            {{ totals.cheapestSingle.currency }}</strong
          >
          <span v-else :class="$style.summaryWarn">无交易所凑齐全部物品</span>
        </span>
        <span :class="[$style.summaryItem, $style.summaryProfit]">
          最优混合总价 ·
          <strong>{{ fixed0(totals.mixedTotal) }}</strong>
          <span :class="$style.summaryNote">（1:1 不含汇率）</span>
        </span>
        <span v-if="burnMode" :class="$style.summaryNote">
          ·
          <template v-if="priceProgress && priceProgress.done < priceProgress.total">
            正在读取游戏实时盘口 {{ priceProgress.done }}/{{ priceProgress.total }}
          </template>
          <template v-else-if="splitMarketMode"
            >卡片仅供比价 · 当前按各物品最优价分市场采购</template
          >
          <template v-else
            >点击卡片指定单市场 · 当前
            <strong :class="$style.currentMarket">{{
              chosenSingleExchange || '无'
            }}</strong></template
          >
        </span>
      </div>

      <!-- 交易所卡片紧跟汇总栏：默认选中最优单市场，点击卡片可指定任意市场；
           勾选「分市场购买」后卡片只作比价，ACT 按各物品最优价分组。
           右上角标「最优」或相对最优的差价，卡片内保留「已指定」标记。 -->
      <div :class="$style.exchangeTotals">
        <div
          v-for="et in totals.exchanges"
          :key="et.code"
          :class="[
            $style.exchangeCard,
            totals.cheapestSingle && totals.cheapestSingle.code === et.code
              ? $style.exchangeCardBest
              : '',
            !et.complete ? $style.exchangeCardIncomplete : '',
            singleMarketMode && chosenSingleExchange === et.code ? $style.exchangeCardChosen : '',
            $style.exchangeCardClickable,
          ]"
          :title="
            splitMarketMode
              ? '当前为分市场购买；点击卡片即切回该交易所单市场购买'
              : chosenSingleExchange === et.code
                ? '当前选中；再点一次或勾选「分市场购买」可改为按最优价分市场购买'
                : '点击选定该交易所为单市场购买的市场'
          "
          @click="pickExchange(et.code)">
          <span
            v-if="exchangeBadge(et)"
            :class="[
              $style.exchangeBadge,
              exchangeBadge(et)?.kind === 'best' ? $style.exchangeBadgeBest : '',
              exchangeBadge(et)?.kind === 'warn' ? $style.exchangeBadgeWarn : '',
            ]">
            {{ exchangeBadge(et)?.text }}
          </span>
          <div :class="$style.exchangeCardHead">
            <strong>{{ et.code }}</strong>
            <span :class="$style.exchangeCurrency">{{ et.currency }}</span>
          </div>
          <div :class="$style.exchangeTotal">{{ fixed0(et.total) }}</div>
          <div :class="$style.exchangeMeta">
            <span v-if="et.complete" :class="$style.completeTag">凑齐</span>
            <span v-else :class="$style.incompleteTag">缺 {{ et.missing }} 种</span>
            <span v-if="singleMarketMode && forcedExchange === et.code" :class="$style.chosenTag">
              ✓ 已指定
            </span>
          </div>
        </div>
      </div>

      <div :class="$style.tableWrap">
        <table :class="$style.table">
          <thead>
            <tr>
              <th :class="$style.checkCol">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  :indeterminate.prop="partialSelected"
                  @change="toggleAll" />
              </th>
              <th :class="$style.materialCol">物品</th>
              <th :class="$style.numCol">数量</th>
              <th
                v-for="ex in exchanges"
                :key="ex.code"
                :class="$style.priceCol"
                :title="`${ex.code} · ${ex.currency}`">
                {{ ex.code }}
              </th>
              <th :class="$style.bestPriceCol">最优价</th>
              <th :class="$style.sourceCol">最优来源</th>
            </tr>
          </thead>
          <tbody v-if="filtered.length === 0">
            <tr>
              <td colspan="100" :class="$style.empty">
                {{
                  components.length === 0
                    ? burnMode
                      ? '该星球暂无可比价的物品。'
                      : '购物车暂无可比价的物品。'
                    : '没有匹配的物品。'
                }}
              </td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="c in filtered" :key="c.ticker">
              <td :class="$style.checkCell">
                <input
                  type="checkbox"
                  :checked="selectedTickers.has(c.ticker)"
                  @change="toggleTicker(c.ticker)" />
              </td>
              <td :class="$style.materialCell">
                <MaterialIcon :ticker="c.ticker" size="medium" />
                <span :class="$style.materialName" :title="`${c.ticker} · ${localized(c)}`">{{
                  localized(c)
                }}</span>
              </td>
              <td :class="$style.numCell">{{ fixed0(c.amount) }}</td>
              <td
                v-for="ex in exchanges"
                :key="ex.code"
                :class="[$style.priceCell, isBest(c, ex.code) ? $style.best : '']">
                <PrunLink
                  v-if="priceOf(c, ex.code)"
                  inline
                  :command="`CXPO ${c.ticker}.${ex.code}`">
                  {{ fixed2(priceOf(c, ex.code)!.price) }}
                  <span :class="$style.currencyTag">{{ ex.currency }}</span>
                </PrunLink>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="[$style.numCell, $style.bestPrice]">
                <span v-if="c.bestPrice !== undefined">
                  {{ fixed2(c.bestPrice) }}
                  <span :class="$style.currencyTag">{{ currencyOf(c.bestExchange!) }}</span>
                </span>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="$style.sourceCell">
                <template v-if="c.bestExchange">
                  <PrunLink inline :command="`CXPO ${c.ticker}.${c.bestExchange}`">
                    <span :class="$style.sourceBadge">{{ c.bestExchange }}</span>
                  </PrunLink>
                  <span
                    v-if="c.bestAmount !== undefined && c.bestAmount > 0"
                    :class="$style.sourceQty"
                    data-tooltip="该价位挂单量"
                    data-tooltip-position="top"
                    >×{{ fixed0(c.bestAmount) }}</span
                  >
                  <span
                    v-if="c.bestLive"
                    :class="$style.liveDot"
                    data-tooltip="实时订单簿"
                    data-tooltip-position="top"></span>
                </template>
                <span v-else :class="$style.muted">--</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style module>
.page {
  overflow-x: hidden;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
}

.controlLabel {
  color: rgb(200, 208, 214);
  white-space: nowrap;
}

.cartMeta {
  color: rgb(148, 158, 166);
  font-size: 12px;
  white-space: nowrap;
}

.cartMeta strong {
  color: rgb(var(--rp-accent-rgb));
}

.input {
  box-sizing: border-box;
  width: 160px;
  padding: 4px 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.input:focus {
  border-color: rgb(var(--rp-accent-rgb));
  box-shadow: inset 0 0 0 1px rgb(var(--rp-accent-rgb));
  background: rgb(30, 38, 44);
}

.input::placeholder {
  color: rgb(148, 158, 166);
}

.control {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 控件栏在最顶部，游戏原生 tooltip 的 z-index 只有 50，往上弹会被标题栏 /
   汇总栏盖住。这里统一下压为向下弹（见模板的 data-tooltip-position="bottom"），
   并抬高浮层层级，保证「分市场购买」「导入到 CONTGEN」的说明完整可读。 */
.controls [data-tooltip]::before,
.controls [data-tooltip]::after {
  z-index: 200 !important;
}

.controls [data-tooltip]::before {
  white-space: normal;
  max-width: 260px;
  line-height: 1.35;
}

.summaryBar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgba(var(--rp-accent-rgb), 0.06);
  border-radius: 4px;
}

.summaryItem {
  color: rgb(200, 208, 214);
  font-size: 12px;
}

.summaryItem strong {
  color: rgb(var(--rp-accent-rgb));
  font-size: 13px;
  padding: 0 2px;
}

.summaryWarn {
  color: rgb(229, 115, 115);
}

.summaryProfit strong {
  color: rgb(126, 217, 87);
}

.summaryNote {
  color: rgb(148, 158, 166);
  font-size: 11px;
}

.currentMarket {
  color: rgb(var(--rp-accent-rgb));
  font-weight: 700;
}

.tableWrap {
  min-width: 0;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

.table th,
.table td {
  padding: 4px 8px;
  vertical-align: middle;
}

.table td {
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.table th {
  color: rgb(200, 208, 214);
  font-weight: normal;
  border-bottom: 1px solid rgb(61, 74, 84);
  white-space: nowrap;
}

.table tbody tr:hover {
  background: rgb(40, 49, 56);
}

.checkCol {
  text-align: center;
  padding: 2px 4px;
}

.checkCol input {
  cursor: pointer;
  accent-color: rgb(var(--rp-accent-rgb));
}

.checkCell {
  text-align: center;
  padding: 2px 4px;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.checkCell input {
  cursor: pointer;
  accent-color: rgb(var(--rp-accent-rgb));
}

.materialCol {
  text-align: left;
  min-width: 180px;
}

.materialCell {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.materialName {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(226, 230, 233);
}

.numCol {
  text-align: center;
  min-width: 60px;
}

.numCell {
  text-align: center;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.priceCol {
  text-align: center;
  min-width: 100px;
}

.priceCell {
  text-align: center;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.priceCell.best {
  background: rgba(129, 199, 132, 0.14);
  border-left: 2px solid rgb(129, 199, 132);
  color: rgb(129, 199, 132);
  font-weight: 600;
}

.bestPriceCol {
  text-align: center;
  min-width: 110px;
}

.bestPrice {
  color: rgb(126, 217, 87);
  font-weight: 600;
  text-align: center;
}

.sourceCol {
  text-align: center;
  min-width: 110px;
}

.sourceCell {
  white-space: nowrap;
  border-bottom: 1px solid rgb(36, 44, 52);
  text-align: center;
}

.sourceBadge {
  display: inline-block;
  min-width: 32px;
  padding: 0 6px;
  border-radius: 2px;
  background: rgba(126, 217, 87, 0.2);
  color: rgb(126, 217, 87);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
}

.sourceQty {
  color: rgb(148, 158, 166);
  font-size: 11px;
  margin-left: 4px;
}

.liveDot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 3px;
  border-radius: 50%;
  background: rgb(129, 199, 132);
  vertical-align: middle;
}

.muted {
  color: rgb(120, 130, 138);
}

.currencyTag {
  color: rgb(148, 158, 166);
  font-size: calc(10px + 1px * var(--rp-font-enlargement));
  margin-left: 3px;
  font-weight: normal;
}

.empty {
  padding: 16px 8px;
  text-align: center;
  color: rgb(167, 176, 183);
}

.exchangeTotals {
  display: grid;
  /* 132px 是「金额不换行」的最低卡宽：15px 数字的千万级金额 + 左右 8px 内边距
     也放得下。配合 CBUY 的 700px 窗口，4 个交易所卡片稳定排成一行不折行。 */
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 6px;
  margin: 2px 0 8px;
}

.exchangeCard {
  position: relative;
  padding: 6px 8px;
  border: 1px solid rgb(61, 74, 84);
  border-radius: 4px;
  background: rgb(26, 33, 38);
}

.exchangeCardBest {
  border-color: rgb(126, 217, 87);
  background: rgba(126, 217, 87, 0.08);
}

.exchangeCardIncomplete {
  opacity: 0.7;
}

/* 交易所卡片可直接点选。选中态必须压过主题注入的单类 !important 规则：
   主题会把 .exchangeCard / .exchangeCardBest 的边框改成浅灰 / 淡绿，
   若这里只写单类且不带 !important，选中卡片会和未选中卡片一模一样。
   用 .exchangeTotals 前缀把特异性提到 0-2-0，并全程 !important。
   颜色走 var()，主题引擎解析不了颜色值，不会二次改写。 */
.exchangeCardClickable {
  cursor: pointer;
}

.exchangeTotals .exchangeCardChosen {
  border: 2px solid var(--rp-skin-selection, #33566f) !important;
  background-color: rgba(var(--rp-accent-rgb), 0.16) !important;
  box-shadow: inset 3px 0 0 var(--rp-skin-selection, #33566f) !important;
  opacity: 1 !important;
}

/* 右上角角标：最优市场标绿色「最优」，其余标橙色差价，缺报价标红色 */
.exchangeBadge {
  position: absolute;
  top: 4px;
  right: 6px;
  color: rgb(var(--rp-accent-rgb));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.exchangeBadgeBest {
  color: rgb(126, 217, 87);
}

.exchangeBadgeWarn {
  color: rgb(229, 115, 115);
}

/* 「已指定」从一行 11px 细字改成实心徽章，和 2px 选中框一起明确指向当前市场。 */
.exchangeTotals .chosenTag {
  margin-left: auto;
  padding: 2px 6px !important;
  border-radius: 3px;
  background-color: var(--rp-skin-selection, #33566f) !important;
  color: var(--rp-skin-bg, #f2f5f7) !important;
  -webkit-text-fill-color: var(--rp-skin-bg, #f2f5f7) !important;
  font-size: 11px !important;
  font-weight: 700 !important;
  letter-spacing: 0.3px;
  line-height: 1.35;
  white-space: nowrap;
}

.exchangeCardHead {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.exchangeCardHead strong {
  color: rgb(var(--rp-accent-rgb));
}

.exchangeCurrency {
  color: rgb(148, 158, 166);
  font-size: 11px;
}

.exchangeTotal {
  color: rgb(226, 230, 233);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  margin-top: 2px;
}

.exchangeMeta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
}

.completeTag {
  color: rgb(126, 217, 87);
}

.incompleteTag {
  color: rgb(229, 115, 115);
}
</style>
