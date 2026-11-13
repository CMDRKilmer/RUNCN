<script setup lang="ts">
import MaterialIcon from '@src/components/MaterialIcon.vue';
import SearchInput from '@src/components/forms/SearchInput.vue';
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
import { repairQuoteRef, REPD_QUOTE_PARAM } from '@src/features/XIT/CART/repair-quote';
import { govhQuoteRef, GOVH_QUOTE_PARAM } from '@src/features/XIT/GOVH/govh-quote';
import {
  deductNeeds,
  getBaseStoreInventory,
  getExchangeWarehouseInventory,
  isCbuyInventoryReady,
  type CbuyDeduction,
  type CbuyInventory,
} from '@src/features/XIT/CART/cbuy-inventory';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { computeNeed, getPlanetBurn, getResupplyDays } from '@src/core/burn';
import { clampTargetDays, getSuppliesCap } from '@src/features/XIT/FLEET/supplies-cap';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { computeComponents, computeTotals, type BpcExchange } from '../BPC/bp-utils';

const cart = computed(() => userData.cart);
const parameters = useXitParameters();

// XIT CBUY 有三种清单来源：
//   1. XIT CBUY            -> XIT CART 购物车（原版行为）
//   2. XIT CBUY <星球编码>  -> 该星球 XIT BURN 消耗品「需要」列（BURN 比价）
//   3. XIT CBUY REPD       -> XIT REPD 当前勾选后的维修购物清单（临时内存）
// 后两种都是临时清单，不读写 userData.cart，不会覆盖用户在 XIT CART 里维护的清单。
const repairMode = computed(() => parameters[0] === REPD_QUOTE_PARAM);
const govhMode = computed(() => parameters[0] === GOVH_QUOTE_PARAM);
const burnNaturalId = computed(() =>
  repairMode.value || govhMode.value ? '' : (parameters[0] ?? ''),
);
const burnMode = computed(() => burnNaturalId.value !== '');
// 临时清单模式：自动刷新盘口、默认全选、价格进度条等行为对 2 / 3 / 4 一视同仁。
const tempMode = computed(() => burnMode.value || repairMode.value || govhMode.value);
// 读响应式 ref，而不是一次性取模块变量：CBUY 窗口会被复用，
// 每次点「比价」都要立刻反映最新勾选的临时清单。
const repairQuote = computed(() => (repairMode.value ? repairQuoteRef.value : undefined));
const repairNeeds = computed(() => repairQuote.value?.items ?? []);
// GOVH 基建补给清单（按 ticker 合并的满仓待补量）。
const govhQuote = computed(() => (govhMode.value ? govhQuoteRef.value : undefined));
const govhNeeds = computed(() => govhQuote.value?.items ?? []);
const burnSite = computed(() =>
  burnMode.value ? sitesStore.getByPlanetNaturalIdOrName(burnNaturalId.value) : undefined,
);
const planetBurn = computed(() => getPlanetBurn(burnSite.value?.siteId));
const burnLoading = computed(() => burnMode.value && planetBurn.value === undefined);

// 「打开航行控制」的目的地：当前要补给的基地所在星球（SFC 只认星球 / 站点地址）。
// BURN 比价取消耗品报告里的星球名（例如 VH-331b，不是基地名），
// REPD 比价取维修清单里的基地编码。
const sfcDestination = computed(() => {
  if (burnMode.value) {
    return planetBurn.value?.[0]?.planetName ?? burnNaturalId.value;
  }
  if (repairMode.value) {
    return repairQuote.value?.naturalId ?? '';
  }
  // GOVH 补给要送到该星球：用星球编码作为 SFC 目的地（游戏 SFC 认星球/站点地址）。
  if (govhMode.value) {
    return govhQuote.value?.planet ?? '';
  }
  return '';
});

// 补给目标天数：与 FLEET dispatch 的默认配置同源（createBaseConfig 用
// getResupplyDays(naturalId)，再按该基地仓储容量上限钳制），保证
// 「XIT CBUY <星球>」与 FLEET 执行预览对同一基地给出完全相同的采购量。
const burnTargetDays = computed(() => {
  const days = getResupplyDays(burnNaturalId.value) ?? 10;
  return clampTargetDays(days, getSuppliesCap(burnSite.value));
});

// 缺口算法统一走 core/burn 的 computeNeed：只看 mat.inventory，不含
// remainingAllocation，与 FLEET 账单 / BURN 需要列 / ACT Resupply 组同一口径。
const burnNeeds = computed(() => {
  const burn = planetBurn.value;
  if (!burnMode.value || !burn) {
    return [];
  }
  const targetDays = burnTargetDays.value;
  return Object.entries(burn.burn)
    .map(([ticker, mat]) => ({
      ticker,
      name: ticker,
      amount: computeNeed(mat, targetDays),
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

// 上游传来的「完整需求」：REPD 传未扣库存的完整维修账单；BURN 传补足到
// 补给天数的消耗品缺口（本身已相对基地库存）；购物车传用户手工维护的数量。
// 所有仓库抵扣都在下面统一做，改这一份即可让比价 / ACT / CONTGEN 同步。
const grossNeeds = computed(() =>
  repairMode.value
    ? repairNeeds.value
    : govhMode.value
      ? govhNeeds.value
      : burnMode.value
        ? burnNeeds.value
        : cartNeeds.value,
);

// 比价模式下生成的 ACT 包 / CONTGEN 清单用独立名字，避免覆盖购物车那份。
const listName = computed(() =>
  repairMode.value
    ? `REPD ${repairQuote.value?.naturalId ?? ''}`
    : govhMode.value
      ? `GOVH ${govhQuote.value?.planet ?? ''}`
      : burnMode.value
        ? `BURN ${burnNaturalId.value}`
        : cart.value.name,
);

const selectedTickers = ref<Set<string>>(new Set());

// 硬编码 4 个玩家 CX 交易所（与 BPC/BMAT/ARB 一致），避免运行时依赖 exchangesStore。
const exchanges: BpcExchange[] = [
  { code: 'AI1', currency: 'AIC' },
  { code: 'CI1', currency: 'CIS' },
  { code: 'IC1', currency: 'ICA' },
  { code: 'NC1', currency: 'NCC' },
];

// ── 交易所选择（提前定义：抵扣基准要跟随当前选中的市场）──────────────
// 单市场模式：选中最便宜且凑齐全部物品的交易所整单购买。
// singleMarketMode=false 时按各物品最优价分市场购买（最优混合）。
const singleMarketMode = ref(true);
// '' = 用最优市场；指定交易所代码则强制用该市场，即使它不是最优（就近采购）。
const forcedExchange = ref('');
const transferToShip = ref(false);
// 生成 ACT 时追加「打开航行控制」步骤：转移完成后打开 SFC，目的地填当前基地星球。
const autoOpenSfc = ref(false);

// BURN 比价的实际链路是「交易所买入 → 转移到飞船 → 飞到补给基地」，
// 所以从 BURN 点「比价」进来时默认把这两项一起勾上；购物车模式保持原样，
// 不替用户预设飞行意图。
watch(
  [burnMode, govhMode],
  ([burn, govh]) => {
    // BURN 与 GOVH 都是「交易所买 → 转移到飞船 → 送到星球」链路，默认勾转移到飞船；
    // 只有 BURN 额外自动打开航行控制（GOVH 让玩家自己决定何时打开，少弹一个窗口）。
    transferToShip.value = burn || govh;
    autoOpenSfc.value = burn;
  },
  { immediate: true },
);

// 复选框与卡片选中互为反向，两个控件状态永远一致：点卡片会自动取消勾选，
// 勾选「分市场购买」后所有卡片橙框消失、只作比价参考。
const splitMarketMode = computed({
  get: () => !singleMarketMode.value,
  set: (value: boolean) => {
    singleMarketMode.value = !value;
  },
});

// 默认市场按「完整需求」算，不随抵扣结果变化，否则会形成
// 「选市场 -> 扣库存 -> 改价格 -> 换最优市场」的循环依赖。
const grossComponents = computed(() => computeComponents(grossNeeds.value, exchanges));
// 仅「已勾选」物料参与「最便宜单交易所 / 最优混合」与 ACT 默认单市场计算，保证卡片
// 和 ACT 用同一组物料算市场，避免出现「卡片标 NC1 最优、ACT 却在 AI1 买」的错位
// （PR #60 审查 #222）。未勾选任何一项时退化为全部，避免购物车首次打开（默认全空）
// 时比价栏空白。
const marketNeeds = computed(() =>
  selectedTickers.value.size > 0
    ? grossNeeds.value.filter(n => selectedTickers.value.has(n.ticker))
    : grossNeeds.value,
);
const marketTotals = computed(() =>
  computeTotals(computeComponents(marketNeeds.value, exchanges), exchanges),
);
const cheapestSingleExchange = computed(() => marketTotals.value.cheapestSingle?.code);
const chosenSingleExchange = computed(() =>
  singleMarketMode.value ? forcedExchange.value || cheapestSingleExchange.value : undefined,
);

// 抵扣基准跟随当前指定的交易所（用户点卡片 = forcedExchange，默认 = 最优单市场）。
// 盘口尚未推回来时最优市场为空，此时依次回退到购物车设定的常用交易所、
// 再兜底第一个交易所，保证页面一打开就按仓库库存抵扣，不会先显示虚高的完整数量。
const deductionExchange = computed(() => {
  if (!tempMode.value) {
    return '';
  }
  return (
    forcedExchange.value || chosenSingleExchange.value || cart.value.exchange || exchanges[0].code
  );
});

// ── 本地仓库库存抵扣 ────────────────────────────────────────────────
// 数据全部来自游戏推送的 store，不连接 FIO；口径与 ACT 执行器一致。
const baseInventory = computed<CbuyInventory>(() =>
  repairMode.value ? getBaseStoreInventory(repairQuote.value?.siteId) : {},
);
// 四个交易所仓库的库存快照：抵扣按「实际出库市场」逐市场取数，而不是统一扣一个市场
// （PR #60 审查 #220）。
const exchangeInventories = computed<Record<string, CbuyInventory>>(() => {
  const map: Record<string, CbuyInventory> = {};
  for (const ex of exchanges) {
    map[ex.code] = getExchangeWarehouseInventory(ex.code);
  }
  return map;
});
const inventoryReady = computed(() => !tempMode.value || isCbuyInventoryReady());

// 每种物料的实际出库（买 / 转）交易所：单市场模式统一为 chosenSingleExchange；
// 分市场模式取各物料的最优价交易所（computeComponents 的 bestExchange，仅由价格决定，
// 与数量 / 是否勾选无关）。抵扣交易所必须和它一致，否则会出现「在 A 市场扣了库存、
// 却从 B 市场买 / 转」的数量错配（PR #60 审查 #220）。
function outboundExchange(ticker: string): string | undefined {
  if (singleMarketMode.value) {
    return chosenSingleExchange.value;
  }
  return grossComponents.value.find(c => c.ticker === ticker)?.bestExchange;
}

const deductions = computed<CbuyDeduction[]>(() =>
  tempMode.value
    ? deductNeeds(
        grossNeeds.value,
        baseInventory.value,
        exchangeInventories.value,
        outboundExchange,
      )
    : grossNeeds.value.map(need => ({
        ticker: need.ticker,
        name: need.name,
        gross: need.amount,
        base: 0,
        exchange: 0,
        transfer: need.amount,
        net: need.amount,
      })),
);
const deductionsByTicker = computed(() => new Map(deductions.value.map(d => [d.ticker, d])));

// 表格清单：凡是需要运到基地的物料都列出，amount 是最终采购量。
// 交易所仓库库存已完全覆盖的行 amount = 0（价格按 0 计，不影响比价），
// 但 MTRA 仍会按 transfer 把它们从交易所仓库一起运走。
// 完全由基地库存满足（既不用买也不用运）的物料不出现在这里。
const needs = computed(() =>
  deductions.value
    .filter(d => d.transfer > 0)
    .map(d => ({ ticker: d.ticker, name: d.name, amount: d.net })),
);

const components = computed(() => computeComponents(needs.value, exchanges));
// 卡片总价 / 缺报价数只统计真正要买的物料，库存已足的行不参与「凑齐」判断。
const pricedComponents = computed(() => components.value.filter(c => c.amount > 0));
// 每张交易所卡片必须用「该交易所自己的仓库库存」算净需求：
// 同一物料在 CI1 有库存、在 AI1 没有时，AI1 的账单里必须包含它，
// 否则 AI1 会漏算这件而虚假地变成最便宜，用户选中后成本又跳回去（PR #60 审查）。
// 非临时模式没有库存抵扣，返回空表让 computeTotals 走原逻辑。
const needsByExchange = computed<Map<string, Map<string, number>>>(() => {
  const map = new Map<string, Map<string, number>>();
  if (!tempMode.value) {
    return map;
  }
  for (const ex of exchanges) {
    // 强制「全部从该市场出库」，得到这个市场自己的抵扣结果。
    const rows = deductNeeds(
      grossNeeds.value,
      baseInventory.value,
      exchangeInventories.value,
      () => ex.code,
    );
    const byTicker = new Map<string, number>();
    for (const row of rows) {
      if (row.transfer > 0) {
        byTicker.set(row.ticker, row.net);
      }
    }
    map.set(ex.code, byTicker);
  }
  return map;
});
const totals = computed(() =>
  computeTotals(components.value, exchanges, selectedTickers.value, needsByExchange.value),
);

const deductedCount = computed(() => deductions.value.filter(d => d.base + d.exchange > 0).length);
const fullyCovered = computed(
  () => deductions.value.filter(d => d.transfer > 0 && d.net === 0).length,
);
const allCoveredByInventory = computed(
  () => tempMode.value && grossNeeds.value.length > 0 && needs.value.length === 0,
);

// 数量列的悬停明细：完整需求 / 基地抵扣 / 交易所抵扣 / 采购量 / 转移量。
function deductionTip(ticker: string) {
  const d = deductionsByTicker.value.get(ticker);
  if (!d || !tempMode.value || d.base + d.exchange === 0) {
    return undefined;
  }
  return [
    `完整需求 ${fixed0(d.gross)}`,
    d.base > 0 ? `基地仓库 −${fixed0(d.base)}` : '',
    d.exchange > 0
      ? `${d.exchangeCode || deductionExchange.value || '交易所'} 仓库 −${fixed0(d.exchange)}`
      : '',
    `= 采购 ${fixed0(d.net)}`,
    `需转移 ${fixed0(d.transfer)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

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

// ACT 分组（购买量 / 转移量分开算）见下方 actGroups。

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

// 按「单市场」或「混合最优」分组的 ACT 清单。
// buy      = 最终下单采购量（已扣基地 / 交易所仓库库存）；
// transfer = 需要运到基地的完整数量（含交易所仓库里原有、无需购买的那部分）。
// 两者分开，才能保证「只买差额、但把仓库原有材料一起运走」，基地不缺料。
interface CbuyActGroup {
  buy: Record<string, number>;
  transfer: Record<string, number>;
}

const actGroups = computed<Map<string, CbuyActGroup>>(() => {
  const groups = new Map<string, CbuyActGroup>();
  const single = singleMarketMode.value ? chosenSingleExchange.value : undefined;
  for (const c of components.value) {
    if (!selectedTickers.value.has(c.ticker)) {
      continue;
    }
    const d = deductionsByTicker.value.get(c.ticker);
    if (!d || d.transfer <= 0) {
      continue;
    }
    // 买：必须能定价，所以用有报价的最优市场；纯转移（net=0）则只要能找到供货仓库
    // 即可路由，不必等报价（交易所仓库里已有这件物料、但暂时没有实时卖单的场景），
    // 否则整行会被 `code` 为空丢弃，导致生成的 ACT 里漏掉这批转运（PR #60 审查 #223）。
    let code = single ?? c.bestExchange;
    if (!code && d.net === 0) {
      code = d.exchangeCode;
    }
    if (!code) {
      continue;
    }
    const group = groups.get(code) ?? { buy: {}, transfer: {} };
    if (d.net > 0) {
      group.buy[c.ticker] = (group.buy[c.ticker] ?? 0) + d.net;
    }
    if (tempMode.value && transferToShip.value) {
      group.transfer[c.ticker] = (group.transfer[c.ticker] ?? 0) + d.transfer;
    }
    groups.set(code, group);
  }
  return groups;
});

// 库存把某些物料的采购量完全抵成 0 时，组内可能只剩 MTRA 转移量；
// 两组都空的市场不值得生成 ACT。
const canGenerateActOptions = computed(() =>
  [...actGroups.value.values()].some(
    group => Object.keys(group.buy).length > 0 || Object.keys(group.transfer).length > 0,
  ),
);

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
  // 记录生成的转移动作名：「打开航行控制」要用它反查飞船（见 open-sfc.ts）。
  const transferActions: string[] = [];
  for (const [exchangeCode, group] of actGroups.value) {
    const groupName = `CBUY_${exchangeCode}`;
    groups.push({ type: 'Manual', name: groupName, materials: group.buy });
    actions.push({
      type: 'CX Buy',
      name: `Buy_${exchangeCode}`,
      group: groupName,
      exchange: exchangeCode,
      priceLimits: {},
      buyPartial: false,
      allowUnfilled: false,
      // 临时清单已在 CBUY 扣过交易所仓库库存，关掉否则 ACT 执行时会二次扣减。
      // 购物车模式没做抵扣，仍交给 ACT 的 useCXInv 自己处理。
      useCXInv: !tempMode.value,
    });
    if (!transferToShip.value) {
      continue;
    }
    if (tempMode.value && Object.keys(group.transfer).length > 0) {
      // 转移组用完整需求：把交易所仓库里原有的那部分一起运走，基地才不缺料。
      const transferName = `${groupName}_TRANSFER`;
      groups.push({ type: 'Manual', name: transferName, materials: group.transfer });
      actions.push({
        type: 'MTRA',
        name: `Transfer_${exchangeCode}`,
        group: transferName,
        origin: getWarehouseName(exchangeCode),
        dest: configurableValue,
      });
    } else {
      actions.push({
        type: 'MTRA',
        name: `Transfer_${exchangeCode}`,
        group: groupName,
        origin: getWarehouseName(exchangeCode),
        dest: configurableValue,
      });
    }
    transferActions.push(`Transfer_${exchangeCode}`);
  }
  // 自动打开航行控制：转移完成后打开 SFC，目的地预填当前补给基地所在星球。
  // 飞船来源取第一个转移动作——单市场购买时它就是唯一一个；分市场购买时
  // OPEN SFC 只能用一艘船，其余交易所的转移仍各自在执行时配置。
  if (
    autoOpenSfc.value &&
    transferToShip.value &&
    transferActions.length > 0 &&
    sfcDestination.value
  ) {
    actions.push({
      type: 'OPEN SFC',
      name: 'Open Flight Controls',
      destination: sfcDestination.value,
      shipSourceAction: transferActions[0],
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
  if (pricedComponents.value.length === 0) {
    return;
  }
  const tickersToSend =
    selectedTickers.value.size > 0
      ? new Set(selectedTickers.value)
      : new Set(pricedComponents.value.map(c => c.ticker));
  const materials: Record<string, number> = {};
  // 只把真正要买的净数量写进合同；库存已抵扣的行 amount = 0，不发 0 数量条目。
  for (const c of pricedComponents.value) {
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

const canSendToContgen = computed(() => pricedComponents.value.length > 0);

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
  // 库存已完全抵扣（amount = 0）的物料不需要比价，不订阅盘口。
  for (const component of pricedComponents.value) {
    for (const exchange of exchanges) {
      const key = `${component.ticker}.${exchange.code}`;
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
// 切换交易所会改变「哪些物料还需要买」，因此用 subscribedKeys 去重后可反复补订阅，
// 而不是只跑一次；refreshing 防止分批过程被并发触发。
const autoTimedOut = shallowRef(false);
const disposed = ref(false);
let autoTimer: number | undefined;
const subscribedKeys = new Set<string>();
let refreshing = false;

async function autoRefreshPrices() {
  if (refreshing || disposed.value) {
    return;
  }
  const keys = pendingCxobKeys().filter(key => !subscribedKeys.has(key));
  if (keys.length === 0) {
    return;
  }
  for (const key of keys) {
    subscribedKeys.add(key);
  }
  refreshing = true;
  if (autoTimer === undefined) {
    autoTimedOut.value = false;
    autoTimer = window.setTimeout(() => (autoTimedOut.value = true), 60000);
  }
  try {
    for (let i = 0; i < keys.length && !disposed.value; i += 6) {
      for (const key of keys.slice(i, i + 6)) {
        if (cxobStore.getByTicker(key) === undefined) {
          openCxob(key, autoTimedOut);
        }
      }
      await new Promise(resolve => window.setTimeout(resolve, 600));
    }
  } finally {
    refreshing = false;
  }
}

onMounted(() => {
  watch(
    () => (tempMode.value ? pricedComponents.value.map(c => c.ticker).join('|') : ''),
    key => {
      if (key) {
        void autoRefreshPrices();
      }
    },
    { immediate: true },
  );
  // 临时清单比价（BURN 消耗品 / REPD 维修材料）默认按整份清单计算。
  // 原组件的勾选框默认全空，而「最优混合总价 / 最便宜单交易所 / 生成 ACT」
  // 都只算已选物品，不初始化就恒为 0。按清单内容初始化一次：之后用户手动
  // 取消勾选（哪怕清空）都不会被强行拉回；换成另一份清单才重新全选。
  // 直接输 XIT CBUY 的购物车模式完全不参与。
  let initializedFor = '';
  watch(
    () => (tempMode.value ? components.value.map(c => c.ticker).join('|') : ''),
    key => {
      if (!tempMode.value || !key || initializedFor === key) {
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
  if (!tempMode.value) {
    return undefined;
  }
  const total = pricedComponents.value.length * exchanges.length;
  let done = 0;
  for (const component of pricedComponents.value) {
    for (const exchange of exchanges) {
      if (cxobStore.getByTicker(`${component.ticker}.${exchange.code}`) !== undefined) {
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
      <span :class="$style.controlLabel">{{ tempMode ? '比价来源' : '购物车' }}</span>
      <span :class="$style.cartMeta" data-cbu-meta>
        <template v-if="repairMode">
          <strong>XIT REPD {{ repairQuote?.naturalId ?? '' }}</strong> ·
          {{ needs.length }} 种维修材料
        </template>
        <template v-else-if="govhMode">
          <strong>XIT GOVH {{ govhQuote?.planet ?? '' }}</strong> · 目标
          {{ Math.round((govhQuote?.target ?? 0) * 100) }}% · {{ needs.length }} 种基建补给
        </template>
        <template v-else-if="burnMode">
          <strong>XIT BURN {{ burnNaturalId }}</strong> · {{ needs.length }} 种需补物资
        </template>
        <template v-else>
          <strong>{{ cart.name }}</strong>
          <template v-if="cart.exchange"> · {{ cart.exchange }}</template>
          · {{ cart.items.length }} 种
        </template>
        <template v-if="tempMode">
          · 抵扣仓库
          <strong :data-cbu-exchange="deductionExchange">{{
            splitMarketMode ? '分市场' : deductionExchange || '—'
          }}</strong>
          <template v-if="repairMode"> + 基地仓库</template>
          <span v-if="!inventoryReady" :class="$style.summaryWarn">（库存读取中…）</span>
          <span v-else
            >（已抵扣 <span data-cbu-deducted>{{ deductedCount }}</span> 种）</span
          >
        </template>
      </span>
      <SearchInput
        id="cbu-search"
        v-model="search"
        name="cbu-search"
        :class="$style.input"
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
      <label
        :class="$style.control"
        data-tooltip="生成 ACT 时追加 MTRA 步骤：把物料从交易所仓库搬进飞船货舱（目的地执行时选船）。从 BURN 比价进来默认勾选"
        data-tooltip-position="bottom">
        <input
          id="cbu-transfer-ship"
          v-model="transferToShip"
          name="cbu-transfer-ship"
          type="checkbox" />
        <span :class="$style.controlLabel">转移到飞船</span>
      </label>
      <label
        v-if="tempMode && sfcDestination"
        :class="[$style.control, transferToShip ? '' : $style.controlDisabled]"
        data-tooltip="转移完成后自动打开 SFC 并输入目的地：目的地预填当前补给基地所在星球；分市场购买时以第一个转移动作的飞船为准"
        data-tooltip-position="bottom">
        <input
          id="cbu-auto-sfc"
          v-model="autoOpenSfc"
          :disabled="!transferToShip"
          name="cbu-auto-sfc"
          type="checkbox" />
        <span :class="$style.controlLabel">打开航行控制</span>
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
      <template v-if="allCoveredByInventory">
        所需材料已全部由基地仓库现有库存满足，无需采购或运输。
      </template>
      <template v-else-if="repairMode">
        维修购物清单为空：请先在 XIT REPD 明细里勾选要修的建筑类型，再点「比价购买」。
      </template>
      <template v-else-if="govhMode">
        基建补给清单为空：请先在 XIT GOVH 里勾选要补给的物料，再点「比价购买」。
      </template>
      <template v-else-if="burnMode">
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
        <span
          v-if="tempMode && deductedCount > 0"
          :class="$style.summaryItem"
          data-cbu-deduction-summary>
          库存抵扣 · <strong>{{ deductedCount }}</strong> 种
          <template v-if="fullyCovered > 0">（{{ fullyCovered }} 种无需采购，仍需转移）</template>
        </span>
        <span v-if="tempMode" :class="$style.summaryNote">
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
                    ? repairMode
                      ? '维修清单暂无可比价的物品。'
                      : burnMode
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
              <!-- 采购量 0 = 仓库库存已完全覆盖：复用表内语义绿，不新增裸色值（主题框架 R01）；
                   这些物料仍会进 MTRA 转移组，不是被漏算。 -->
              <td
                :class="[$style.numCell, c.amount === 0 ? $style.bestPrice : '']"
                :data-cbu-ticker="c.ticker"
                :data-cbu-net="c.amount"
                :title="deductionTip(c.ticker)">
                {{ fixed0(c.amount) }}
              </td>
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

/* 依赖项未勾选时的禁用态：只降透明度，不引入新的裸色值（主题框架 R01）。 */
.controlDisabled {
  opacity: 0.45;
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
