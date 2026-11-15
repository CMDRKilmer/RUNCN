<script setup lang="ts">
import MaterialIcon from '@src/components/MaterialIcon.vue';
import SearchInput from '@src/components/forms/SearchInput.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { cxStore } from '@src/infrastructure/fio/cx';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0, fixed2 } from '@src/utils/format';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import { getWarehouseName } from '@src/features/XIT/CART/cart-utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { getTileState } from '@src/store/user-data-tiles';
import {
  collectBlueprintNeeds,
  computeComponents,
  computeTotals,
  type BpcExchange,
} from './bp-utils';

const search = ref('');

// 蓝图列表按名称排序。访问 blueprintsStore.all 会触发一次 BLU 缓冲窗请求
// （request-hooks 内部有 singleBufferRequest 守卫，只开一次）。
// 与 BLU 的隐藏清单联动：在 BLU「指令」列隐藏过的蓝图（存 naturalId 或 id）
// 默认不再出现在下拉里；BLU 右上角开关打开「显示隐藏蓝图」时这里也恢复完整列表。
const hiddenBlueprints = computed(() => new Set(userData.settings.hiddenBlueprints ?? []));
const showHiddenBlueprints = computed(() => userData.settings.showHiddenBlueprints ?? false);
const blueprints = computed(() =>
  (blueprintsStore.all.value ?? [])
    .filter(
      bp =>
        showHiddenBlueprints.value ||
        (!hiddenBlueprints.value.has(bp.naturalId) && !hiddenBlueprints.value.has(bp.id)),
    )
    .slice()
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
);
const blueprintOptions = computed(() =>
  blueprints.value.map(bp => ({
    label: `${bp.name} (${bp.naturalId})`,
    value: bp.naturalId,
  })),
);

const selectedBlueprintId = ref('');
const selectedTickers = ref<Set<string>>(new Set());
watch(
  blueprints,
  list => {
    if (list.length > 0 && !list.some(bp => bp.naturalId === selectedBlueprintId.value)) {
      selectedBlueprintId.value = list[0].naturalId;
    }
  },
  { immediate: true },
);
watch(selectedBlueprintId, () => {
  selectedTickers.value = new Set();
});

const selectedBlueprint = computed(() =>
  blueprints.value.find(bp => bp.naturalId === selectedBlueprintId.value),
);

// 硬编码 4 个玩家 CX 交易所（与 ARB 一致）。硬编码避免运行时依赖 exchangesStore
// 在不同游戏版本/账户状态下返回不同交易所列表（导致列数变化、列对齐错位）。
const exchanges: BpcExchange[] = [
  { code: 'AI1', currency: 'AIC' },
  { code: 'CI1', currency: 'CIS' },
  { code: 'IC1', currency: 'ICA' },
  { code: 'NC1', currency: 'NCC' },
];

const needs = computed(() => collectBlueprintNeeds(selectedBlueprint.value));
const components = computed(() => computeComponents(needs.value, exchanges));
const totals = computed(() => computeTotals(components.value, exchanges, selectedTickers.value));

const noData = computed(() => !cxStore.fetched);
const noBlueprints = computed(() => blueprints.value.length === 0);

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

// 已选配件（按 ticker 去重），按全市场最优交易所分组。
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

// ACT 生成选项。默认按各配件最优价混合采购；勾选「单市场购买」或点交易所卡片
// 后，整单统一从指定市场买（与 XIT CBUY 的卡片交互一致）。
const singleMarketMode = ref(false);
// '' = 用最优市场；指定交易所代码则强制用该市场，即使它不是最优（就近采购）。
const forcedExchange = ref('');
const transferToShip = ref(false);

const cheapestSingleExchange = computed(() => totals.value.cheapestSingle?.code);
const chosenSingleExchange = computed(() =>
  singleMarketMode.value ? forcedExchange.value || cheapestSingleExchange.value : undefined,
);

// 卡片右上角角标：最优市场标「最优」，其余标相对最优的价差（1:1 口径）；
// 没凑齐全部配件的市场总价不可比，改标缺报价数，避免负差价。
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
// 单市场模式：所有配件统一从 chosenSingleExchange（卡片指定或最优）买。
// 混合模式（默认）：每个配件按各自最优交易所买。
const actGroups = computed(() => {
  if (singleMarketMode.value) {
    const code = chosenSingleExchange.value;
    if (!code) {
      return new Map<string, Record<string, number>>();
    }
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

function generateAct() {
  if (actGroups.value.size === 0) {
    return;
  }
  const groups: UserData.MaterialGroupData[] = [];
  const actions: UserData.ActionData[] = [];
  for (const [exchangeCode, materials] of actGroups.value) {
    const groupName = `BPC_${exchangeCode}`;
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
      // 不勾"转移到飞船"：跳过 MTRA，由玩家手动从仓库转运。
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
  // 包名用 blueprint.naturalId（必为 ASCII ID 如 BP-DHEZ-4037）做前缀，
  // 配合 blueprint.name 做完整可读名（如 "BP-DHEZ-4037 HWS Defense Missile Buy"）。
  // 这样既避开了 PrUn 对非 ASCII 参数解析失败的问题，
  // 又让 ACT 列表里包名可读。
  const bp = selectedBlueprint.value;
  const bpId = bp?.naturalId ?? 'Blueprint';
  // 包名仅保留 ASCII 字母 / 数字 / hyphen（兼容 BP-DHEZ-4037 这类 naturalId）。
  // 中文 / 括号 / 引号 / & 等符号都会被 strip 掉，避免 PrUn XIT 参数解析失败。
  // 连续符号 / 空白折叠为单个空格，给后续命令名拼接留可读结构。
  const asciiName = (bp?.name ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = asciiName ? `${bpId} ${asciiName} Buy` : `${bpId} Buy`;
  const pkg: UserData.ActionPackageData = { global: { name }, groups, actions };
  // 与 CART.generateAct 一致：若同名包已存在则覆盖，避免重复建包。
  const existing = userData.actionPackages.findIndex(p => p.global.name === name);
  if (existing >= 0) {
    userData.actionPackages[existing] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
  const commandName = name.replace(/\s+/g, '_');
  showBuffer(`XIT ACT_${commandName}`);
}

// 已选配件（如未选则全部）按 ticker:amount 序列化为顶层 materials 形态
// 的 JSON，写到 'contgen-import' workspace key，然后打开 CONTGEN 缓冲窗。
// CONTGEN 在 onMounted 消费一次后立即清空该 key，避免下次刷新又触发。
//
// 价格字段不传递——BPC 算的是最优买入价，与合同 / BUY/SELL 价格无关；
// CONTGEN 会按顶部 BUY/SELL 的缺单价规则标红，由玩家手动填写。
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
  // 用 blueprint.name 作合同名——CONTGEN 收到后写到顶部「合同名称」字段。
  // 与下方 generateAct 用同一段 ASCII 净化（XIT 参数仅吃 ASCII）：
  //   1. 去非 ASCII 字符；
  //   2. 把非 [A-Za-z0-9-] 折叠为单个空格；
  //   3. 收敛尾随 / 重复空白。
  // BPC 的 generateAct 拼的是 ${bpId} ${asciiName} Buy；这里只给单
  // 个 name，免得污染用户后续手动改名的空间。
  const bp = selectedBlueprint.value;
  const asciiName = (bp?.name ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const payload: { materials: Record<string, number>; name?: string } = { materials };
  if (asciiName.length > 0) {
    payload.name = asciiName;
  }
  const ws = getTileState<{ json?: string }>('contgen-import');
  ws.json = JSON.stringify(payload);
  showBuffer('XIT CONTGEN');
}

const canSendToContgen = computed(() => components.value.length > 0);

// 与 ARB 一致：对当前可见的所有 (ticker, 交易所) 打开 CXOB 缓冲窗，
// 拉取实时订单簿（cxobStore 收到数据后 bp-utils.ts 会自动切换到 live 价格）。
function refreshPrices() {
  const requested = new Set<string>();
  for (const component of components.value) {
    for (const exchange of exchanges) {
      const key = `${component.ticker}.${exchange.code}`;
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

function localized(component: { ticker: string; name: string }): string {
  const material = materialsStore.getByTicker(component.ticker);
  return getMaterialName(material) ?? component.name ?? component.ticker;
}

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
      <label :class="$style.control">
        <span :class="$style.controlLabel">蓝图</span>
        <select
          id="bpc-blueprint"
          v-model="selectedBlueprintId"
          name="bpc-blueprint"
          :class="$style.select"
          style="width: 260px">
          <option v-for="opt in blueprintOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <SearchInput
        id="bpc-search"
        v-model="search"
        name="bpc-search"
        :class="$style.input"
        placeholder="搜索配件 ticker 或名称" />
      <PrunButton primary @click="refreshPrices">更新价格</PrunButton>
      <label
        :class="$style.control"
        data-tooltip="整单统一从指定交易所采购；不勾选则按各配件最优价分市场购买"
        data-tooltip-position="bottom">
        <input
          id="bpc-single-market"
          v-model="singleMarketMode"
          name="bpc-single-market"
          type="checkbox"
          :disabled="!cheapestSingleExchange" />
        <span :class="$style.controlLabel">单市场购买</span>
      </label>
      <label :class="$style.control">
        <input
          id="bpc-transfer-ship"
          v-model="transferToShip"
          name="bpc-transfer-ship"
          type="checkbox" />
        <span :class="$style.controlLabel">转移到飞船</span>
      </label>
      <PrunButton primary :disabled="!canGenerateActOptions" @click="generateAct"
        >生成 ACT</PrunButton
      >
      <PrunButton
        primary
        :disabled="!canSendToContgen"
        data-tooltip="把当前已选配件清单发送到 CONTGEN 用于起草合同"
        data-tooltip-position="bottom"
        @click="sendToContgen"
        >导入到 CONTGEN</PrunButton
      >
    </div>

    <div v-if="noBlueprints" :class="$style.empty">
      尚未加载到任何蓝图（请先打开 BLU 命令，或在 BLU 里恢复被隐藏的蓝图）。
    </div>
    <div v-else-if="noData" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</div>
    <template v-else>
      <div :class="$style.summaryBar">
        <span :class="$style.summaryItem">
          配件 ·
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
          <span v-else :class="$style.summaryWarn">无交易所凑齐全部配件</span>
        </span>
        <span :class="[$style.summaryItem, $style.summaryProfit]">
          最优混合总价 ·
          <strong>{{ fixed0(totals.mixedTotal) }}</strong>
          <span :class="$style.summaryNote">（1:1 不含汇率）</span>
        </span>
        <span :class="$style.summaryItem">
          <template v-if="singleMarketMode">
            点击卡片指定单市场 · 当前
            <strong :class="$style.currentMarket">{{ chosenSingleExchange || '无' }}</strong>
          </template>
          <template v-else>按各配件最优价混合采购 · 点击卡片可指定单市场</template>
        </span>
      </div>

      <!-- 交易所卡片紧跟汇总栏：默认只作比价，点击可指定任意单市场；
           右上角标「最优」或相对最优的差价，卡片内保留「已指定」标记。
           与 XIT CBUY 的卡片区保持同一套结构与外观。 -->
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
            !singleMarketMode
              ? '当前为混合采购；点击卡片即切到该交易所单市场购买'
              : chosenSingleExchange === et.code
                ? '当前选中；再点一次可回到按最优价分市场购买'
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
              <th :class="$style.materialCol">配件</th>
              <th :class="$style.numCol">需求</th>
              <th :class="$style.priceCol" title="AI1 · ICA">AI1</th>
              <th :class="$style.priceCol" title="CI1 · ICA">CI1</th>
              <th :class="$style.priceCol" title="IC1 · ICA">IC1</th>
              <th :class="$style.priceCol" title="NC1 · NCA">NC1</th>
              <th :class="$style.bestPriceCol">最优价</th>
              <th :class="$style.sourceCol">最优来源</th>
            </tr>
          </thead>
          <tbody v-if="filtered.length === 0">
            <tr>
              <td colspan="100" :class="$style.empty">
                {{ components.length === 0 ? '该蓝图暂无物料清单。' : '没有匹配的配件。' }}
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
              </td>
              <td :class="$style.numCell">{{ fixed0(c.amount) }}</td>
              <td :class="[$style.priceCell, isBest(c, 'AI1') ? $style.best : '']">
                <PrunLink v-if="priceOf(c, 'AI1')" inline :command="`CXPO ${c.ticker}.AI1`">
                  {{ fixed2(priceOf(c, 'AI1')!.price) }}
                  <span :class="$style.currencyTag">{{ currencyOf('AI1') }}</span>
                </PrunLink>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="[$style.priceCell, isBest(c, 'CI1') ? $style.best : '']">
                <PrunLink v-if="priceOf(c, 'CI1')" inline :command="`CXPO ${c.ticker}.CI1`">
                  {{ fixed2(priceOf(c, 'CI1')!.price) }}
                  <span :class="$style.currencyTag">{{ currencyOf('CI1') }}</span>
                </PrunLink>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="[$style.priceCell, isBest(c, 'IC1') ? $style.best : '']">
                <PrunLink v-if="priceOf(c, 'IC1')" inline :command="`CXPO ${c.ticker}.IC1`">
                  {{ fixed2(priceOf(c, 'IC1')!.price) }}
                  <span :class="$style.currencyTag">{{ currencyOf('IC1') }}</span>
                </PrunLink>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="[$style.priceCell, isBest(c, 'NC1') ? $style.best : '']">
                <PrunLink v-if="priceOf(c, 'NC1')" inline :command="`CXPO ${c.ticker}.NC1`">
                  {{ fixed2(priceOf(c, 'NC1')!.price) }}
                  <span :class="$style.currencyTag">{{ currencyOf('NC1') }}</span>
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
  border-color: rgb(var(--rp-accent-rgb));
  box-shadow: inset 0 0 0 1px rgb(var(--rp-accent-rgb));
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

/* 控件栏在最顶部，游戏原生 tooltip 的 z-index 只有 50，往上弹会被标题栏 /
   汇总栏盖住（与 XIT CBUY 同样的修复）。统一下压为向下弹并抬高浮层层级。 */
.controls [data-tooltip]::before,
.controls [data-tooltip]::after {
  z-index: 200 !important;
}

.controls [data-tooltip]::before {
  white-space: normal;
  max-width: 260px;
  line-height: 1.35;
}

.tableWrap {
  min-width: 0;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  /* auto：列宽按内容+min-width 自动分配；表格自动占满父容器宽度。 */
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
  text-align: center;
  min-width: 60px;
}

.materialCell {
  text-align: center;
  border-bottom: 1px solid rgb(36, 44, 52);
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
     也放得下。配合 BPC 的 700px 窗口，4 个交易所卡片稳定排成一行不折行。 */
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
   用 .exchangeTotals 前缀把特异性提到 0-2-0，并全程 !important；
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

/* 「已指定」实心徽章，和 2px 选中框一起明确指向当前市场。 */
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
