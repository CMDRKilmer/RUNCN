<script setup lang="ts">
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { cxStore } from '@src/infrastructure/fio/cx';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, fixed02, fixed2, percent2 } from '@src/utils/format';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import {
  computeOpportunities,
  getArbExchanges,
  getCategories,
  resolveCategoryLabel,
  type ArbOpportunity,
} from './arb-utils';
import { computeAllocatedProfit } from './arb-profit';

const search = ref('');
const categoryFilter = ref('ALL');
const sortKey = ref('profitPct');

// 路线选择：出发地（买入）/ 目的地（卖出）。
const allExchanges = computed(() => getArbExchanges());
const exchangeOptions = computed(() =>
  allExchanges.value.map(x => ({ label: x.code, value: x.code })),
);
const destCurrency = computed(
  () => allExchanges.value.find(x => x.code === destExchange.value)?.currency ?? '',
);
const sourceExchange = ref('IC1');
const destExchange = ref('');
watch(
  allExchanges,
  list => {
    if (list.length > 0 && !destExchange.value) {
      destExchange.value = list.find(x => x.code === 'AI1')?.code ?? list.at(-1)?.code ?? '';
    }
  },
  { immediate: true },
);

const categoryOptions = computed(() => [
  { label: '全部类别', value: 'ALL' },
  ...getCategories().map(id => ({ label: resolveCategoryLabel(id), value: id })),
]);

const sortOptions = [
  { label: '利润率', value: 'profitPct' },
  { label: '单价利润', value: 'profitPerUnit' },
  { label: '总利润', value: 'totalProfit' },
  { label: '可成交量', value: 'executableVolume' },
];

const opportunities = computed(() =>
  computeOpportunities(sourceExchange.value, destExchange.value),
);

const noData = computed(() => !cxStore.fetched);

// 飞船选择 + 容量优化。
// 飞船的「载货容量」是其 SHIP_STORE 的 volumeCapacity（减去已装载的 volumeLoad），
// 不是 Ship.volume（后者是飞船物理排水体积）。
interface ShipWithCargo {
  ship: PrunApi.Ship;
  cargoVolume: number;
  cargoWeight: number;
  freeVolume: number;
  freeWeight: number;
  hasCargo: boolean;
}

// 直接用 ship.idShipStore 查找对应的 SHIP_STORE。
// 这是项目里既定的查找模式（见 src/core/store-id.ts:23）。
function findShipCargoStore(ship: PrunApi.Ship): PrunApi.Store | undefined {
  const stores = storagesStore.all.value ?? [];
  return stores.find(x => x.id === ship.idShipStore && x.type === 'SHIP_STORE');
}

const ships = computed<ShipWithCargo[]>(() => {
  const allShips = shipsStore.all.value ?? [];
  return allShips
    .map(s => {
      const cargoStore = findShipCargoStore(s);
      const cargoVolume = cargoStore?.volumeCapacity ?? 0;
      const cargoWeight = cargoStore?.weightCapacity ?? 0;
      const freeVolume = Math.max(0, cargoVolume - (cargoStore?.volumeLoad ?? 0));
      const freeWeight = Math.max(0, cargoWeight - (cargoStore?.weightLoad ?? 0));
      return { ship: s, cargoVolume, cargoWeight, freeVolume, freeWeight, hasCargo: !!cargoStore };
    })
    .filter(x => x.hasCargo);
});

const shipOptions = computed(() => [
  { label: '不选飞船', value: '' },
  ...ships.value.map(x => ({
    label: `${x.ship.registration} ${x.ship.name} | 余 ${fixed0(x.freeWeight)}/${fixed0(x.cargoWeight)} t · 余 ${fixed0(x.freeVolume)}/${fixed0(x.cargoVolume)} m³`,
    value: x.ship.id,
  })),
]);
const selectedShipId = ref('');
const selectedSelected = computed(
  () => ships.value.find(x => x.ship.id === selectedShipId.value) ?? null,
);

// 用户手动勾选的商品 ticker 集合（默认空，用户需主动勾选）。
const checkedTickers = ref<Set<string>>(new Set());

// 单商品体积（m³/件）。直接复用 BURN/ACT 的算法：material.volume 缺失时按 0 处理
// （贪心里 cap 会立刻为 0，避免基于错误回退值导致估算偏小、装出 ACT 实际无法容下的量）。
function unitVolume(opp: ArbOpportunity): number {
  const material = materialsStore.getByTicker(opp.ticker);
  return material && material.volume > 0 ? material.volume : 0;
}

// 单商品重量（t/件），与 BURN/ACT 一致。
function unitWeight(opp: ArbOpportunity): number {
  const material = materialsStore.getByTicker(opp.ticker);
  return material && material.weight > 0 ? material.weight : 0;
}

function maxUnitsFor(opp: ArbOpportunity): number {
  if (!selectedSelected.value) return opp.executableVolume;
  const sel = selectedSelected.value;
  const v = unitVolume(opp);
  const w = unitWeight(opp);
  if (v <= 0 || w <= 0) return 0;
  const byVol = sel.freeVolume > 0 ? Math.floor(sel.freeVolume / v) : Infinity;
  const byWeight = sel.freeWeight > 0 ? Math.floor(sel.freeWeight / w) : Infinity;
  return Math.min(opp.executableVolume, byVol, byWeight);
}

function shipFitsAny(opp: ArbOpportunity): boolean {
  if (!selectedSelected.value) return true;
  return maxUnitsFor(opp) > 0;
}

function toggleChecked(ticker: string, ev: Event) {
  const checked = (ev.target as HTMLInputElement).checked;
  const next = new Set(checkedTickers.value);
  if (checked) next.add(ticker);
  else next.delete(ticker);
  checkedTickers.value = next;
}

// 表头全选复选框的状态：所有可见且装得下的 ticker 都已勾选时为「勾选」；
// 部分勾选时为「半选」；否则为「未勾选」。
const selectAllRef = shallowRef<HTMLInputElement | null>(null);
const selectAllState = computed(() => {
  const fit = new Set<string>();
  for (const o of filtered.value) {
    if (shipFitsAny(o)) {
      fit.add(o.ticker);
    }
  }
  if (fit.size === 0) {
    return { checked: false, indeterminate: false };
  }
  let checked = 0;
  for (const t of fit) {
    if (checkedTickers.value.has(t)) {
      checked++;
    }
  }
  if (checked === 0) {
    return { checked: false, indeterminate: false };
  }
  if (checked === fit.size) {
    return { checked: true, indeterminate: false };
  }
  return { checked: false, indeterminate: true };
});
watchEffect(() => {
  if (selectAllRef.value) {
    selectAllRef.value.indeterminate = selectAllState.value.indeterminate;
  }
});
function toggleSelectAll(ev: Event) {
  const checked = (ev.target as HTMLInputElement).checked;
  if (checked) {
    const next = new Set<string>();
    for (const o of filtered.value) {
      if (shipFitsAny(o)) {
        next.add(o.ticker);
      }
    }
    checkedTickers.value = next;
  } else {
    checkedTickers.value = new Set();
  }
}

// 同 ticker 现在可能存在多行（每个价格档位 × 每个目的地的组合各占一行）。
// 装载按 (ticker, 买入交易所, 买入价) 维度聚合：同一买入价位的所有卖出配对
// 共享同一买入来源，容量取所有卖出配对可成交上限之和（受限于 min(buyQty, Σ sellQty)）。
interface ShipmentItem {
  ticker: string;
  buyExchange: string;
  buyPrice: number;
  profitPerUnit: number;
  totalSellQty: number;
  totalCapacity: number;
  v: number;
  w: number;
}

function buildShipmentItems(): ShipmentItem[] {
  // 同一买入价位 (ticker, buyExchange, buyPrice) 是唯一货源。
  // 该价位总可买量 = min( 买单总量, 该价位下所有卖出配对的卖单总量之和 )。
  // 之前用 buyQuantity 直接封顶会导致 sellQuantity < buyQuantity 时超买。
  const byKey = new Map<string, ShipmentItem>();
  for (const o of filtered.value) {
    if (!checkedTickers.value.has(o.ticker) || o.profitPerUnit <= 0) continue;
    const key = `${o.ticker}|${o.buyExchange}|${o.buyPrice}`;
    const v = unitVolume(o);
    const w = unitWeight(o);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        ticker: o.ticker,
        buyExchange: o.buyExchange,
        buyPrice: o.buyPrice,
        profitPerUnit: o.profitPerUnit,
        totalSellQty: o.sellQuantity,
        totalCapacity: Math.min(o.buyQuantity, o.sellQuantity),
        v,
        w,
      });
    } else {
      existing.totalSellQty += o.sellQuantity;
      existing.totalCapacity = Math.min(o.buyQuantity, existing.totalSellQty);
    }
  }
  return Array.from(byKey.values());
}

const suggestedUnits = (() => {
  const cache = new Map<string, number>();
  const computeFingerprint = (): string => {
    const checked = Array.from(checkedTickers.value).sort();
    return `${selectedShipId.value}|${checked.join(',')}`;
  };
  const compute = (opp: ArbOpportunity): number => {
    if (!selectedSelected.value) return 0;
    const fingerprint = computeFingerprint();
    const itemKey = `${opp.ticker}|${opp.buyExchange}|${opp.buyPrice}`;
    const cacheKey = `${fingerprint}|${itemKey}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (!checkedTickers.value.has(opp.ticker)) {
      cache.set(cacheKey, 0);
      return 0;
    }

    const items = buildShipmentItems();
    if (items.length === 0) {
      cache.set(cacheKey, 0);
      return 0;
    }

    const sel = selectedSelected.value;
    let remVol = sel.freeVolume;
    let remWt = sel.freeWeight;
    let mine = 0;
    // 贪心：按 profitPerUnit / max(vol, weight/50) 降序分配容量。
    const sorted = items.slice().sort((a, b) => {
      const normA = Math.max(a.v, a.w / 50);
      const normB = Math.max(b.v, b.w / 50);
      return b.profitPerUnit / normB - a.profitPerUnit / normA;
    });
    for (const it of sorted) {
      // 单位缺失时无法估算体积/重量消耗，跳过装载，避免 ACT 实际超出船容。
      if (it.v <= 0 || it.w <= 0) continue;
      const byVol = Math.floor(remVol / it.v);
      const byWt = Math.floor(remWt / it.w);
      const cap = Math.min(it.totalCapacity, byVol, byWt);
      if (cap <= 0) continue;
      remVol -= cap * it.v;
      remWt -= cap * it.w;
      if (
        it.ticker === opp.ticker &&
        it.buyExchange === opp.buyExchange &&
        it.buyPrice === opp.buyPrice
      ) {
        mine = cap;
      }
    }
    cache.set(cacheKey, mine);
    return mine;
  };
  return Object.assign(compute, { clear: () => cache.clear() });
})();

// 同一买入价位 (ticker, buyExchange, buyPrice) 的 `units` 件货会分散到该价位下
// 的多个卖出配对（每个配对有自己的 sellQuantity 与 profitPerUnit）。实际执行时
// 先吃掉利润最高的卖单，每档受其 sellQuantity 封顶。直接用 units × 最高利润
// 会把最高卖价套到所有件上、虚增「预期利润」，因此按档加权计算。
function profitForBuyLevel(opp: ArbOpportunity, units: number): number {
  if (units <= 0) {
    return 0;
  }
  const pairs = filtered.value
    .filter(
      o =>
        o.ticker === opp.ticker && o.buyExchange === opp.buyExchange && o.buyPrice === opp.buyPrice,
    )
    .map(o => ({ qty: o.sellQuantity, profitPerUnit: o.profitPerUnit }));
  return computeAllocatedProfit(pairs, units);
}

// 该 ticker 的预期总利润（按 ticker 聚合所有行）。
// 同 (ticker, buyExchange, buyPrice) 价位下多 sell 配对只计一次，否则同一贪心
// 分配的 cap 会被 suggestedUnits 缓存重复返回。
function totalExpectedProfitFor(ticker: string): number {
  let total = 0;
  const counted = new Set<string>();
  for (const o of filtered.value) {
    if (o.ticker !== ticker) continue;
    const itemKey = `${o.buyExchange}|${o.buyPrice}`;
    if (counted.has(itemKey)) continue;
    const units = suggestedUnits(o);
    if (units <= 0) continue;
    counted.add(itemKey);
    total += profitForBuyLevel(o, units);
  }
  return total;
}

// 该 ticker 的贪心装载总件数（用于 ACT 一键脚本的 material 用量）。
function totalSuggestedUnits(ticker: string): number {
  let total = 0;
  const counted = new Set<string>();
  for (const o of filtered.value) {
    if (o.ticker !== ticker) continue;
    const itemKey = `${o.buyExchange}|${o.buyPrice}`;
    if (counted.has(itemKey)) continue;
    const units = suggestedUnits(o);
    if (units <= 0) continue;
    counted.add(itemKey);
    total += units;
  }
  return total;
}

// Reactive data age (re-evaluates each minute via timestampEachMinute).
const dataAgeMinutes = computed(() => {
  if (cxStore.age === 0) {
    return null;
  }
  void timestampEachMinute.value;
  return Math.max(0, Math.floor((Date.now() - cxStore.age) / 60000));
});

function sortValue(o: ArbOpportunity): number {
  switch (sortKey.value) {
    case 'profitPerUnit':
      return o.profitPerUnit;
    case 'totalProfit':
      return o.totalProfit;
    case 'executableVolume':
      return o.executableVolume;
    case 'profitPct':
    default:
      return o.profitPct;
  }
}

const filtered = computed(() => {
  let list = opportunities.value.filter(o => o.profitPerUnit > 0);
  if (categoryFilter.value !== 'ALL') {
    list = list.filter(o => o.category === categoryFilter.value);
  }
  const query = search.value.trim().toLowerCase();
  if (query) {
    list = list.filter(o => {
      const localized = localizedName(o).toLowerCase();
      return `${o.ticker} ${o.name} ${localized}`.toLowerCase().includes(query);
    });
  }
  return list.slice().sort((a, b) => sortValue(b) - sortValue(a));
});

// 缓存仅在单次渲染内去重。filtered（价格/数量）或飞船余量变化时必须清空，
// 否则点击「更新价格」或飞船货舱变化后仍返回旧装载量，导致汇总与 ACT 脚本
// 使用过期数据（缓存 key 不含数量/余量，会命中旧值）。
watch([filtered, selectedSelected], () => suggestedUnits.clear());

// 总体汇总：总重量、总容积、总花费、总预期利润。
// 按 (ticker, buyExchange, buyPrice) 去重累加，否则同价位下多个卖出配对会让
// suggestedUnits 缓存命中并被重复计入会虚增总重量/体积。
const summary = computed(() => {
  let totalWeight = 0;
  let totalVolume = 0;
  let totalCost = 0;
  let totalProfit = 0;
  const counted = new Set<string>();
  for (const o of filtered.value) {
    if (!checkedTickers.value.has(o.ticker)) continue;
    const itemKey = `${o.ticker}|${o.buyExchange}|${o.buyPrice}`;
    if (counted.has(itemKey)) continue;
    const units = suggestedUnits(o);
    if (units <= 0) continue;
    counted.add(itemKey);
    totalWeight += unitWeight(o) * units;
    totalVolume += unitVolume(o) * units;
    totalCost += o.buyPrice * units;
    totalProfit += profitForBuyLevel(o, units);
  }
  return { totalWeight, totalVolume, totalCost, totalProfit };
});

// 出发地交易所币种（用于显示总花费）。
const sourceCurrency = computed(
  () => allExchanges.value.find(x => x.code === sourceExchange.value)?.currency ?? '',
);

// 一键生成 ACT 脚本：把勾选 + 贪心分配的商品打包成一个 CX Buy action package，
// 推入 userData.actionPackages 并自动打开 ACT_EDIT 缓冲窗。
function generateActScript() {
  if (!selectedSelected.value || checkedTickers.value.size === 0) return;

  const materials: Record<string, number> = {};
  for (const ticker of checkedTickers.value) {
    const units = totalSuggestedUnits(ticker);
    if (units <= 0) continue;
    materials[ticker] = units;
  }
  if (Object.keys(materials).length === 0) return;

  const ship = selectedSelected.value.ship;
  const exchange = sourceExchange.value;
  // 包名必须用空格分隔。ACT.vue 的参数解析会把 _ 拆开再 join(' ') 还原，
  // 但如果 name 本身就含 _，lookup 时找不到。
  const groupName = `ARB ${ship.registration}`;
  const pkgName = `ARB ${ship.registration} ${exchange} ${Date.now()}`;

  // 解析 CX Buy 落地仓库（买到的货存在这里）以及飞船 cargo 仓库，
  // 以便后面追加 MTRA action 把买到的货转移到飞船。
  const naturalId = exchangesStore.getNaturalIdFromCode(exchange);
  const cxWarehouse = warehousesStore.getByEntityNaturalId(naturalId);
  const cxWarehouseStore = storagesStore.getById(cxWarehouse?.storeId);
  const shipStore = storagesStore.getById(ship.idShipStore);
  const origin = cxWarehouseStore ? serializeStorage(cxWarehouseStore) : undefined;
  const dest = shipStore ? serializeStorage(shipStore) : undefined;

  const pkg: UserData.ActionPackageData = {
    global: { name: pkgName },
    groups: [
      {
        type: 'Manual',
        name: groupName,
        materials,
      },
    ],
    actions: [
      {
        type: 'CX Buy',
        name: 'ARB Buy',
        group: groupName,
        exchange,
        priceLimits: {},
        buyPartial: false,
        allowUnfilled: false,
        useCXInv: true,
      },
      ...(origin !== undefined && dest !== undefined
        ? [
            {
              type: 'MTRA' as const,
              name: 'ARB Transfer',
              group: groupName,
              origin,
              dest,
            },
          ]
        : []),
    ],
  };

  userData.actionPackages.push(pkg);
  showBuffer('XIT ACT_EDIT_' + pkgName.split(' ').join('_'));
}

// 一次性后台静默加载 filtered 表中实际出现的 (ticker, exchange) 实时订单簿。
// 服务器推送 COMEX_BROKER_DATA 后自动关闭隐藏缓冲窗。
async function loadLiveOrderBooks() {
  const requested = new Set<string>();
  for (const o of filtered.value) {
    for (const ex of [o.buyExchange, o.sellExchange]) {
      const key = `${o.ticker}.${ex}`;
      if (requested.has(key) || cxobStore.getByTicker(key) !== undefined) {
        continue;
      }
      requested.add(key);
      showBuffer(`CXOB ${key}`, {
        autoClose: true,
        closeWhen: computed(() => cxobStore.getByTicker(key) !== undefined),
      });
    }
  }
}

function localizedName(o: ArbOpportunity): string {
  const material = materialsStore.getByTicker(o.ticker);
  return getMaterialName(material) ?? o.name;
}

function localizedCategory(o: ArbOpportunity): string {
  return resolveCategoryLabel(o.category);
}
</script>

<template>
  <div :class="$style.page">
    <div :class="$style.warning">
      <span>
        市场信息有时效性，倒货需谨慎
        <span v-if="dataAgeMinutes !== null" :class="$style.warningAge">
          · FIO 数据 {{ dataAgeMinutes }} 分钟前
        </span>
      </span>
    </div>

    <div :class="$style.usage">使用方法：选择路线后点击"更新价格"按钮。</div>

    <div :class="$style.controls">
      <input
        id="arb-search"
        v-model="search"
        name="arb-search"
        :class="$style.input"
        type="text"
        placeholder="搜索 ticker 或名称" />
      <label :class="$style.control">
        <span :class="$style.controlLabel">类别</span>
        <select
          id="arb-category"
          v-model="categoryFilter"
          name="arb-category"
          :class="$style.select"
          style="width: 100px">
          <option v-for="opt in categoryOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label :class="$style.control">
        <span :class="$style.controlLabel">排序</span>
        <select
          id="arb-sort"
          v-model="sortKey"
          name="arb-sort"
          :class="$style.select"
          style="width: 80px">
          <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label :class="$style.control">
        <span :class="$style.controlLabel">出发地</span>
        <select
          id="arb-source"
          v-model="sourceExchange"
          name="arb-source"
          :class="$style.select"
          style="width: 60px">
          <option v-for="opt in exchangeOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label :class="$style.control">
        <span :class="$style.controlLabel">目的地</span>
        <select
          id="arb-dest"
          v-model="destExchange"
          name="arb-dest"
          :class="$style.select"
          style="width: 60px">
          <option v-for="opt in exchangeOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <PrunButton primary @click="loadLiveOrderBooks">更新价格</PrunButton>
      <label :class="$style.control">
        <span :class="$style.controlLabel">飞船</span>
        <select
          id="arb-ship"
          v-model="selectedShipId"
          name="arb-ship"
          :class="$style.select"
          style="width: 280px">
          <option v-for="opt in shipOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <span v-if="selectedSelected" :class="$style.shipInfo">
        {{ selectedSelected.ship.registration }} · 重量 余
        <strong>{{ fixed0(selectedSelected.freeWeight) }}</strong> /
        {{ fixed0(selectedSelected.cargoWeight) }} t · 容积 余
        <strong>{{ fixed0(selectedSelected.freeVolume) }}</strong> /
        {{ fixed0(selectedSelected.cargoVolume) }} m³
      </span>
    </div>

    <div v-if="selectedSelected" :class="$style.summaryBar">
      <span :class="$style.summaryItem">
        计划装载 ·
        <strong>{{ fixed02(summary.totalWeight) }}</strong> t ·
        <strong>{{ fixed02(summary.totalVolume) }}</strong> m³
      </span>
      <span :class="$style.summaryItem">
        总花费 ·
        <strong>{{ fixed0(summary.totalCost) }}</strong>
        {{ sourceCurrency }}
      </span>
      <span :class="[$style.summaryItem, $style.summaryProfit]">
        预期总利润 ·
        <strong>{{ fixed0(summary.totalProfit) }}</strong>
        {{ destCurrency }}
      </span>
      <PrunButton primary :disabled="checkedTickers.size === 0" @click="generateActScript">
        生成 ACT 一键购买脚本 ({{ checkedTickers.size }})
      </PrunButton>
    </div>

    <div :class="$style.tableWrap">
      <table :class="$style.table">
        <thead>
          <tr>
            <th :class="$style.checkCol">
              <input
                id="arb-select-all"
                ref="selectAllRef"
                type="checkbox"
                :checked="selectAllState.checked"
                @change="toggleSelectAll" />
            </th>
            <th :class="$style.materialCol">商品</th>
            <th :class="$style.categoryCol">类别</th>
            <th :class="$style.marketCol">买入</th>
            <th :class="$style.marketCol">卖出</th>
            <th :class="$style.numCol">单价利润</th>
            <th :class="$style.numCol">利润率</th>
            <th :class="$style.numCol">可成交量</th>
            <th :class="$style.numCol">建议装载</th>
            <th :class="$style.numCol">预期利润</th>
            <th :class="$style.numCol">总利润</th>
          </tr>
        </thead>
        <tbody v-if="noData">
          <tr>
            <td colspan="11" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</td>
          </tr>
        </tbody>
        <tbody v-else-if="filtered.length === 0">
          <tr>
            <td colspan="11" :class="$style.empty">没有符合条件的套利机会。</td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="o in filtered" :key="o.key">
            <td :class="$style.checkCell">
              <input
                type="checkbox"
                :checked="checkedTickers.has(o.ticker)"
                :disabled="!shipFitsAny(o)"
                @change="toggleChecked(o.ticker, $event)" />
            </td>
            <td :class="$style.materialCell">
              <MaterialIcon :ticker="o.ticker" size="medium" />
            </td>
            <td :class="$style.categoryCell">{{ localizedCategory(o) }}</td>
            <td :class="[$style.marketCell, $style.marketCellBuy]">
              <span :class="[$style.marketBadge, $style.buyBadge]">买</span>
              <span :class="$style.marketExchange">
                <PrunLink inline :command="`CXPO ${o.ticker}.${o.buyExchange}`">
                  {{ o.buyExchange }}
                </PrunLink>
                <span :class="$style.marketPrice"
                  >{{ fixed2(o.buyPrice) }} {{ o.buyCurrency }}</span
                >
                <span
                  :class="$style.marketQty"
                  data-tooltip="该价位上的订单数量"
                  data-tooltip-position="top"
                  >×{{ fixed0(o.buyQuantity) }}</span
                >
                <span
                  v-if="o.buyLive"
                  :class="$style.liveDot"
                  data-tooltip="实时订单簿"
                  data-tooltip-position="top"></span>
              </span>
            </td>
            <td :class="[$style.marketCell, $style.marketCellSell]">
              <span :class="[$style.marketBadge, $style.sellBadge]">卖</span>
              <span :class="$style.marketExchange">
                <PrunLink inline :command="`CXPO ${o.ticker}.${o.sellExchange}`">
                  {{ o.sellExchange }}
                </PrunLink>
                <span :class="$style.marketPrice"
                  >{{ fixed2(o.sellPrice) }} {{ o.sellCurrency }}</span
                >
                <span
                  :class="$style.marketQty"
                  data-tooltip="该价位上的订单数量"
                  data-tooltip-position="top"
                  >×{{ fixed0(o.sellQuantity) }}</span
                >
                <span
                  v-if="o.sellLive"
                  :class="$style.liveDot"
                  data-tooltip="实时订单簿"
                  data-tooltip-position="top"></span>
              </span>
            </td>
            <td :class="[$style.numCell, o.profitPerUnit > 0 ? $style.pos : $style.neg]">
              {{ fixed2(o.profitPerUnit) }}
            </td>
            <td :class="[$style.numCell, o.profitPerUnit > 0 ? $style.pos : $style.neg]">
              {{ percent2(o.profitPct) }}
            </td>
            <td :class="$style.numCell">
              {{ fixed0(o.executableVolume) }}
            </td>
            <td :class="$style.numCell">
              <span v-if="suggestedUnits(o) > 0" :class="$style.suggestedBadge">
                {{ fixed0(suggestedUnits(o)) }}
              </span>
              <span v-else>--</span>
            </td>
            <td
              :class="[
                $style.numCell,
                totalExpectedProfitFor(o.ticker) > 0 ? $style.pos : $style.neg,
              ]">
              {{
                totalExpectedProfitFor(o.ticker) > 0
                  ? fixed0(totalExpectedProfitFor(o.ticker))
                  : '--'
              }}
            </td>
            <td :class="[$style.numCell, o.profitPerUnit > 0 ? $style.pos : $style.neg]">
              {{ fixed0(o.totalProfit) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style module>
.page {
  overflow-x: hidden;
}

.subTitle {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 2px 0 6px;
  color: rgb(167, 176, 183);
  font-size: 12px;
}

.warning {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-bottom: 4px;
  border: 1px solid rgb(204, 110, 56);
  border-left-width: 3px;
  background: rgba(204, 110, 56, 0.1);
  color: rgb(238, 154, 89);
  font-size: 12px;
  font-weight: 600;
}

.warningAge {
  color: rgb(194, 120, 70);
  font-weight: normal;
}

.usage {
  padding: 0 0 6px;
  color: rgb(167, 176, 183);
  font-size: 12px;
}

.age {
  color: rgb(148, 158, 166);
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
}

.input {
  box-sizing: border-box;
  width: 140px;
  padding: 4px 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.input:focus {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
  background: rgb(30, 38, 44);
}

.input::placeholder {
  color: rgb(148, 158, 166);
}

.select {
  box-sizing: border-box;
  padding: 3px 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.select:focus {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
  background: rgb(30, 38, 44);
}

.control {
  display: flex;
  align-items: center;
  gap: 4px;
}

.controlLabel {
  color: rgb(200, 208, 214);
  white-space: nowrap;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  white-space: nowrap;
  color: rgb(200, 208, 214);
}

.checkbox input {
  accent-color: rgb(255, 176, 0);
}

.shipInfo {
  color: rgb(167, 176, 183);
  font-size: 12px;
  padding-left: 4px;
}

.shipInfo strong {
  color: rgb(255, 176, 0);
}

.summaryBar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgba(255, 176, 0, 0.06);
  border-radius: 4px;
}

.summaryItem {
  color: rgb(200, 208, 214);
  font-size: 12px;
}

.summaryItem strong {
  color: rgb(255, 176, 0);
  font-size: 13px;
  padding: 0 2px;
}

.summaryProfit strong {
  color: rgb(126, 217, 87);
}

.checkCol {
  width: 32px;
  text-align: center;
  padding: 2px 4px;
}

.checkCol input {
  accent-color: rgb(255, 176, 0);
  cursor: pointer;
}

.checkCell {
  text-align: center;
  padding: 2px 4px;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.checkCell input {
  accent-color: rgb(255, 176, 0);
  cursor: pointer;
}

.checkCell input:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.suggestedBadge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(255, 176, 0, 0.2);
  color: rgb(255, 200, 64);
  font-weight: 600;
  font-size: 11px;
}

.tableWrap {
  min-width: 0;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.table th,
.table td {
  padding: 4px 8px;
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
}

.table th {
  color: rgb(200, 208, 214);
  font-weight: normal;
  border-bottom: 1px solid rgb(61, 74, 84);
}

.table tbody tr:hover {
  background: rgb(40, 49, 56);
}

.materialCol {
  width: 54px;
}

.materialCell {
  text-align: center;
}

.categoryCol {
  width: 12%;
  min-width: 80px;
}

.numCol {
  width: 92px;
  text-align: right;
}

.categoryCell {
  color: rgb(167, 176, 183);
  font-size: 11px;
}

.marketCell {
  padding: 2px 6px;
  border-left: 2px solid rgb(46, 56, 64);
}

.marketExchange {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: middle;
  cursor: pointer;
}

.marketPrice {
  color: rgb(200, 208, 214);
  font-size: 11px;
}

.marketQty {
  color: rgb(148, 158, 166);
  font-size: 11px;
}

.marketCellBuy {
  background: rgba(129, 199, 132, 0.08);
  border-left-color: rgb(129, 199, 132);
}

.marketCellSell {
  background: rgba(229, 115, 115, 0.08);
  border-left-color: rgb(229, 115, 115);
}

.marketBadge {
  display: inline-block;
  min-width: 14px;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  font-weight: bold;
  color: rgb(26, 33, 38);
}

.buyBadge {
  background: rgb(129, 199, 132);
}

.sellBadge {
  background: rgb(229, 115, 115);
  color: rgb(255, 255, 255);
}

.marketCol {
  width: 22%;
  min-width: 220px;
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

.numCell {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.pos {
  color: rgb(129, 199, 132);
}

.neg {
  color: rgb(229, 115, 115);
}

.empty {
  padding: 16px 8px;
  text-align: center;
  color: rgb(167, 176, 183);
}
</style>
