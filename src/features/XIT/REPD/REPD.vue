<script setup lang="ts">
import BaseAlias from '@src/components/BaseAlias.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import MaterialPurchaseTable from '@src/components/MaterialPurchaseTable.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import PrunButton from '@src/components/PrunButton.vue';
import PrunLink from '@src/components/PrunLink.vue';
import Tooltip from '@src/components/Tooltip.vue';
import { setRepairQuote } from '@src/features/XIT/CART/repair-quote';
import { repairBuildingsByType } from '@src/features/basic/bra-repair-execute';
import {
  calculateBillAtOffset,
  calculateRepairBoard,
  getRepairBoardSettings,
  repairStatus,
} from '@src/features/XIT/REPD/entries';
import type {
  RepairBoardBase,
  RepairBoardStatus,
  RepairBoardType,
} from '@src/features/XIT/REPD/entries';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { userData } from '@src/store/user-data';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, fixed1, formatCurrency, percent1 } from '@src/utils/format';
import { sumBy } from '@src/utils/sum-by';

const $style = useCssModule();

// 维修设置原本在 XIT SET → 维修，现搬到本看板左侧总览上方，改完即刻重算看板。
// 迁移已为存量用户回填，这里再兜一次底，避免控件拿到 undefined。
userData.settings.repairBoard ??= {
  useOptimal: true,
  targetDays: 90,
  dueSoonDays: 7,
  arrivalDays: 0,
  subtractStore: true,
};

const board = userData.settings.repairBoard;

const arrivalModel = computed({
  get: () => String(board.arrivalDays),
  set: (value: string) => {
    board.arrivalDays = Number(value);
  },
});

const arrivalOptions = [
  { label: '今天', value: '0' },
  { label: '24 小时后', value: '1' },
  { label: '48 小时后', value: '2' },
];

const settings = computed(() => getRepairBoardSettings());

const bases = computed(() => calculateRepairBoard(timestampEachMinute.value));

type FilterKey = 'all' | 'overdue' | 'soon' | 'later';
const filter = ref<FilterKey>('all');

const selectedSiteId = ref<string>();

// 默认选中第一个（最紧急）基地，打开即可看到明细。
const selected = computed<RepairBoardBase | undefined>(() => {
  const list = bases.value;
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  return list.find(x => x.siteId === selectedSiteId.value) ?? list[0];
});

const counts = computed(() => {
  const list = bases.value ?? [];
  return {
    overdue: list.filter(x => x.status === 'overdue').length,
    soon: list.filter(x => x.status === 'soon').length,
    later: list.filter(x => x.status === 'later').length,
  };
});

const statCards = computed(() => [
  { key: 'overdue' as FilterKey, label: '逾期', count: counts.value.overdue, tone: $style.red },
  {
    key: 'soon' as FilterKey,
    label: `即将（${settings.value.dueSoonDays} 天）`,
    count: counts.value.soon,
    tone: $style.amber,
  },
  { key: 'later' as FilterKey, label: '正常', count: counts.value.later, tone: $style.green },
]);

function toggleFilter(key: FilterKey) {
  filter.value = filter.value === key ? 'all' : key;
}

const filteredBases = computed(() => {
  const list = bases.value ?? [];
  return filter.value === 'all' ? list : list.filter(x => x.status === filter.value);
});

const dueBases = computed(() => (bases.value ?? []).filter(x => x.status !== 'later'));
const dueCost = computed(() => sumBy(dueBases.value, x => x.billCost ?? 0) ?? 0);
const dueWeight = computed(() => dueBases.value.reduce((sum, x) => sum + x.loadWeight, 0));
const dueVolume = computed(() => dueBases.value.reduce((sum, x) => sum + x.loadVolume, 0));
const totalWaiting = computed(() => sumBy(bases.value ?? [], x => x.waitingPerDay ?? 0) ?? 0);

// 三色沿用游戏自身的补给/维护状态色。游戏表格的 td 背景对本组件的 class 优先级更高，
// 这里直接走内联样式，保证颜色一定压得住。
const STATUS_COLORS: Record<RepairBoardStatus, string> = {
  overdue: 'rgba(217, 83, 79, 0.3)',
  soon: 'rgba(247, 166, 0, 0.3)',
  later: 'rgba(92, 184, 92, 0.3)',
};

function statusStyle(status: RepairBoardStatus) {
  return status === 'overdue'
    ? { backgroundColor: STATUS_COLORS.overdue, color: '#d9534f', fontWeight: 'bold' }
    : { backgroundColor: STATUS_COLORS[status] };
}

function formatCost(value?: number) {
  return value === undefined ? '--' : formatCurrency(value);
}

function remainingText(dueIn: number) {
  return String(Math.floor(dueIn));
}

function targetText(base: RepairBoardBase) {
  return base.targetIsOptimal
    ? `${fixed0(base.targetDay)}（最优）`
    : `${fixed0(base.targetDay)}（固定）`;
}

function typeStatus(type: RepairBoardType) {
  return repairStatus(type.dueIn, settings.value.dueSoonDays);
}

// ── 明细勾选：只把勾中的建筑类型计入购物清单 ────────────────────────────
// 默认勾「逾期 + 即将到期」的类型（与左侧三色判定同一口径），未到期的不选；
// 切换基地时按新基地状态重置，之后用户手动改动一直保持到下次切换。
const selectedTypes = ref<Set<string>>(new Set());
const repairing = ref(false);
const repairMessage = ref<string | undefined>(undefined);

function defaultSelectedTypes(base: RepairBoardBase | undefined): Set<string> {
  if (!base) {
    return new Set();
  }
  return new Set(
    base.types
      .filter(type => repairStatus(type.dueIn, settings.value.dueSoonDays) !== 'later')
      .map(type => type.ticker),
  );
}

watch(
  () => selected.value?.siteId,
  siteId => {
    selectedTypes.value = defaultSelectedTypes(siteId ? selected.value : undefined);
    // 切换基地后，上一次维修的反馈文案不再适用，清空避免误导。
    repairMessage.value = undefined;
  },
  { immediate: true },
);

function isTypeSelected(ticker: string) {
  return selectedTypes.value.has(ticker);
}

function toggleType(ticker: string) {
  const next = new Set(selectedTypes.value);
  if (next.has(ticker)) {
    next.delete(ticker);
  } else {
    next.add(ticker);
  }
  selectedTypes.value = next;
}

const allTypesSelected = computed(
  () =>
    !!selected.value &&
    selected.value.types.length > 0 &&
    selected.value.types.every(type => selectedTypes.value.has(type.ticker)),
);

function toggleAllTypes() {
  if (!selected.value) {
    return;
  }
  selectedTypes.value = allTypesSelected.value
    ? new Set()
    : new Set(selected.value.types.map(type => type.ticker));
}

const selectedRowStyle = { backgroundColor: 'rgba(255, 255, 255, 0.12)' };
const selectedAccentStyle = { boxShadow: 'inset 3px 0 0 #5aa9e6' };

// ── 偏移天数：按「飞船 N 天后抵达」实时重算重量 / 体积 / 费用 ──
const offsetOptions = [0, 1, 2, 3, 5, 7];
const offsetDays = ref(settings.value.arrivalDays);

// 在上方设置栏改「飞船抵达」时，右侧明细的偏移选择同步到这个默认值；
// 之后手动点偏移按钮仍可临时覆盖，不回写持久化设置。
watch(
  () => settings.value.arrivalDays,
  days => {
    offsetDays.value = days;
  },
);

const offsetBill = computed(() => {
  const base = selected.value;
  if (!base) {
    return undefined;
  }
  return calculateBillAtOffset(
    base.siteId,
    offsetDays.value,
    settings.value.subtractStore,
    timestampEachMinute.value,
    selectedTypes.value,
  );
});

const todayBill = computed(() => {
  const base = selected.value;
  if (!base) {
    return undefined;
  }
  return calculateBillAtOffset(
    base.siteId,
    0,
    settings.value.subtractStore,
    timestampEachMinute.value,
    selectedTypes.value,
  );
});

const offsetDelta = computed(() => {
  const at = offsetBill.value?.cost;
  const today = todayBill.value?.cost;
  return at === undefined || today === undefined ? undefined : at - today;
});

// 「比价」与「ACT」共用的完整维修账单：当前勾选建筑类型 + 当前抵达偏移，
// 未扣任何库存（第三个参数 false）。两条链路必须读同一份数据，
// 否则 REPD 直接 ACT 与「比价 → CBUY → ACT」会算出不同的数量与金额。
// 库存抵扣（基地仓库 + 交易所仓库）统一由下游 CBUY / 生成 ACT 对话框负责，
// 避免两处各扣一遍。
const currentBill = computed(() => {
  const base = selected.value;
  if (!base) {
    return undefined;
  }
  return calculateBillAtOffset(
    base.siteId,
    offsetDays.value,
    false,
    timestampEachMinute.value,
    selectedTypes.value,
  )?.load;
});

// 「比价购买」复用 XIT BURN 的 XIT CBUY 入口：把当前勾选类型的完整维修账单
// 交给 CBUY 的临时清单模式，再开窗做四交易所实时盘口比价。
// 同样不扣库存，抵扣与 MTRA 转移量由 CBUY 统一算。
// 清单一路走模块内存，不读写 XIT CART 购物车，不新增任何外部价格源。
function onCompare() {
  const base = selected.value;
  if (!base) {
    return;
  }
  const load = currentBill.value;
  if (!load || load.length === 0) {
    return;
  }
  setRepairQuote({
    siteId: base.siteId,
    naturalId: base.naturalId,
    items: load.map(x => ({
      ticker: x.material.ticker,
      name: x.material.ticker,
      amount: x.amount,
    })),
  });
  showBuffer('XIT CBUY REPD');
}

// ── 一键维修已选类型：复用 BRA 的逐栋维修执行，作用于明细里勾选的类型 ──
// 按钮固定在购物清单上方、高度恒定，不随勾选 / 反馈变化把购物清单挤下去。
async function onRepairSelected() {
  const base = selected.value;
  if (!base || repairing.value || selectedTypes.value.size === 0) {
    return;
  }
  repairing.value = true;
  repairMessage.value = undefined;
  try {
    const result = await repairBuildingsByType(base.siteId, selectedTypes.value);
    repairMessage.value = result.message;
  } finally {
    repairing.value = false;
  }
}

// 维修前的仓库材料校验：算出勾选类型的完整维修账单（不扣库存），与基地仓库现有库存比对。
// 充足则提示绿色「仓库充足」；有缺口则列出缺料（提示先走「比价购买」补货）。
// 这层只是提示——真正执行时仍由游戏原生维修按钮的 disabled 状态决定每栋能否修，
// 缺料的栋会被游戏跳过，不会卡死或报错。
const baseInventory = computed<Record<string, number>>(() => {
  const base = selected.value;
  const inv: Record<string, number> = {};
  if (!base) {
    return inv;
  }
  for (const store of storagesStore.all.value ?? []) {
    if (store.addressableId !== base.siteId) {
      continue;
    }
    for (const item of store.items) {
      if (item.type !== 'INVENTORY' || !item.quantity) {
        continue;
      }
      const ticker = item.quantity.material?.ticker;
      if (ticker) {
        inv[ticker] = (inv[ticker] ?? 0) + item.quantity.amount;
      }
    }
  }
  return inv;
});

// 维修材料清单（外显）：勾选类型的完整维修账单（不扣库存）逐材料列出
// 需求总量、基地仓库现有量、缺口。缺口 > 0 黄色、否则绿色；按缺口从大到小排序。
const repairMaterials = computed<{ ticker: string; need: number; have: number; missing: number }[]>(
  () => {
    const base = selected.value;
    if (!base || selectedTypes.value.size === 0) {
      return [];
    }
    const full = calculateBillAtOffset(
      base.siteId,
      offsetDays.value,
      false,
      timestampEachMinute.value,
      selectedTypes.value,
    );
    if (!full) {
      return [];
    }
    const inv = baseInventory.value;
    return full.load
      .map(x => {
        const have = inv[x.material.ticker] ?? 0;
        return {
          ticker: x.material.ticker,
          need: x.amount,
          have,
          missing: Math.max(0, x.amount - have),
        };
      })
      .sort((a, b) =>
        b.missing - a.missing !== 0 ? b.missing - a.missing : a.ticker.localeCompare(b.ticker),
      );
  },
);
</script>

<template>
  <LoadingSpinner v-if="bases === undefined" />
  <div v-else-if="bases.length === 0" :class="$style.empty">没有可维修的基地建筑。</div>
  <div v-else :class="$style.layout">
    <div :class="$style.overview">
      <!-- 维修设置（原 XIT SET → 维修）：独立成栏，置于左侧总览最上方。 -->
      <div :class="$style.settings" data-rp-repd-settings>
        <div :class="$style.panelTitle">维修设置</div>
        <div :class="$style.settingsRows">
          <div :class="$style.settingItem">
            <span :class="$style.settingLabel">目标维修日</span>
            <Tooltip
              position="bottom"
              tooltip="开启后，每个基地的目标维修日由插件按整站收益与维修成本算出（与 FLEET 维修列同一套算法）；关闭则统一使用下面的固定天数。游戏里没有 plan 概念，这是 PRUNplanner 最优间隔的替代口径。" />
            <RadioItem v-model="board.useOptimal" horizontal>按插件算出的最优间隔</RadioItem>
          </div>
          <div :class="$style.settingItem">
            <span :class="$style.settingLabel">固定天数</span>
            <Tooltip
              position="bottom"
              tooltip="关闭最优间隔时使用。填多少天，就把「上次维修后第几天该修」当作目标，到期即变红。" />
            <NumberInput v-model="board.targetDays" />
          </div>
          <div :class="$style.settingItem">
            <span :class="$style.settingLabel">即将到期阈值</span>
            <Tooltip
              position="bottom"
              tooltip="距离目标日还剩这么多天及以内时，状态标为「即将到期」（黄）。" />
            <NumberInput v-model="board.dueSoonDays" />
          </div>
          <div :class="$style.settingItem">
            <span :class="$style.settingLabel">飞船抵达</span>
            <Tooltip
              position="bottom"
              tooltip="账单按飞船哪天抵达计算。今天 / 24 小时后 / 48 小时后三档直接取游戏给的维修材料，不再自己用公式折算。" />
            <SelectInput v-model="arrivalModel" :options="arrivalOptions" />
          </div>
          <div :class="$style.settingItem">
            <span :class="$style.settingLabel">库存抵扣</span>
            <Tooltip
              position="bottom"
              tooltip="开启后，购物清单只列基地现成库存之外还缺的数量；关闭则列出完整账单。" />
            <RadioItem v-model="board.subtractStore" horizontal>扣掉基地现成库存</RadioItem>
          </div>
        </div>
      </div>
      <div :class="$style.stats">
        <button
          v-for="card in statCards"
          :key="card.key"
          type="button"
          :class="[$style.statCard, filter === card.key && $style.statCardActive]"
          @click="toggleFilter(card.key)">
          <span :class="$style.statLabel">{{ card.label }}</span>
          <span :class="[$style.statValue, card.count > 0 && card.tone]">{{ card.count }}</span>
        </button>
        <div :class="$style.statBox">
          <span :class="$style.statLabel">到期费用</span>
          <span :class="$style.statValue">{{ formatCost(dueCost) }}</span>
          <span :class="$style.statNote">
            {{ fixed0(dueWeight) }}t · {{ fixed0(dueVolume) }}m³ · {{ dueBases.length }} 站
          </span>
        </div>
        <div :class="$style.statBox">
          <span :class="$style.statLabel">每日等待</span>
          <span :class="[$style.statValue, $style.amber]">{{ formatCost(totalWaiting) }}</span>
          <span :class="$style.statNote">每多等一天多出的维修材料</span>
        </div>
      </div>
      <div :class="$style.listScroll">
        <table :class="$style.compact">
          <thead>
            <tr>
              <th>基地</th>
              <th :class="$style.numeric">最优</th>
              <th :class="$style.numeric">剩余</th>
              <th :class="$style.numeric">状况</th>
              <th :class="$style.numeric">费用</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="base in filteredBases"
              :key="base.siteId"
              :style="base.siteId === selected?.siteId ? selectedRowStyle : undefined"
              @click="selectedSiteId = base.siteId">
              <td :style="base.siteId === selected?.siteId ? selectedAccentStyle : undefined">
                <PrunLink inline :command="`BRA ${base.naturalId}`">
                  {{ base.naturalId }}
                </PrunLink>
                <BaseAlias :site-id="base.siteId" />
              </td>
              <td
                :class="$style.numeric"
                :title="base.targetIsOptimal ? '插件算出的最优间隔' : '设置里的固定天数'">
                {{ fixed0(base.targetDay) }}
              </td>
              <td :class="$style.numeric" :style="statusStyle(base.status)">
                {{ remainingText(base.dueIn) }}
              </td>
              <td :class="$style.numeric">{{ percent1(base.condition) }}</td>
              <td :class="$style.numeric">{{ formatCost(base.billCost) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div :class="$style.side">
      <div v-if="selected" :class="[$style.panel, $style.detail]">
        <div :class="$style.panelTitle">
          明细 ·
          <PrunLink inline :command="`BRA ${selected.naturalId}`">
            {{ selected.naturalId }}
          </PrunLink>
          <BaseAlias :site-id="selected.siteId" />
        </div>
        <div :class="$style.meta">
          整站目标 {{ targetText(selected) }} · 最老 {{ fixed1(selected.ageDays) }} 天 ·
          {{ selected.buildingCount }} 栋 / {{ selected.typeCount }} 类
        </div>
        <div :class="$style.detailBody">
          <table :class="$style.compact" data-rp-repd-detail>
            <thead>
              <tr>
                <th :class="$style.checkCol">
                  <input
                    type="checkbox"
                    :checked="allTypesSelected"
                    :title="allTypesSelected ? '清空选择' : '全选本基地类型'"
                    @change="toggleAllTypes" />
                </th>
                <th>类型</th>
                <th
                  :class="$style.numeric"
                  title="每种建筑类型各自算出的最优维修间隔；算不出时用维修设置里的固定天数">
                  最优
                </th>
                <th :class="$style.numeric">数量</th>
                <th :class="$style.numeric">年龄</th>
                <th :class="$style.numeric">剩余</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="type in selected.types" :key="type.ticker" :data-repd-type="type.ticker">
                <td :class="$style.checkCol">
                  <input
                    type="checkbox"
                    :checked="isTypeSelected(type.ticker)"
                    :aria-label="`选择 ${type.ticker}`"
                    @change="toggleType(type.ticker)" />
                </td>
                <td>{{ type.ticker }}</td>
                <td
                  :class="$style.numeric"
                  :title="
                    type.targetIsOptimal
                      ? '按该类型产能收益与建设成本算出的最优间隔'
                      : '维修设置里的固定天数'
                  ">
                  {{ fixed0(type.targetDay) }}
                </td>
                <td :class="$style.numeric">{{ type.count }}</td>
                <td :class="$style.numeric">{{ fixed1(type.ageDays) }}</td>
                <td :class="$style.numeric" :style="statusStyle(typeStatus(type))">
                  {{ remainingText(type.dueIn) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div :class="$style.repairBar" data-rp-repd-repair>
          <PrunButton
            dark
            inline
            :disabled="!selectedTypes.size || repairing"
            data-rp-repd-repair-btn
            @click="onRepairSelected">
            {{ repairing ? '维修中…' : '维修已选类型' }}
          </PrunButton>
          <span :class="$style.repairMsg" data-rp-repd-repair-msg>{{ repairMessage }}</span>
        </div>
        <div :class="$style.repairTableWrap" data-rp-repd-matlist>
          <table :class="[$style.compact, $style.repairTable]">
            <thead>
              <tr>
                <th>材料</th>
                <th :class="$style.numeric">需求</th>
                <th :class="$style.numeric">现有</th>
                <th :class="$style.numeric">缺口</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in repairMaterials" :key="m.ticker">
                <td :class="$style.matTicker">{{ m.ticker }}</td>
                <td :class="$style.numeric">{{ fixed0(m.need) }}</td>
                <td :class="[$style.numeric, $style.matHave]">{{ fixed0(m.have) }}</td>
                <td :class="[$style.numeric, m.missing > 0 ? $style.matMiss : $style.matOk]">
                  {{ m.missing > 0 ? fixed0(m.missing) : '充足' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div :class="$style.bottomGroup" data-rp-repd-bottom>
          <div :class="$style.offsetRow">
            <span :class="$style.offsetLabel">偏移</span>
            <button
              v-for="day in offsetOptions"
              :key="day"
              type="button"
              :class="[$style.offsetBtn, offsetDays === day && $style.offsetActive]"
              @click="offsetDays = day">
              {{ day === 0 ? '今天' : `+${day}` }}
            </button>
            <span :class="$style.waitInline">
              等待 {{ formatCost(selected.waitingPerDay) }}/天 · 状况
              {{ percent1(selected.condition) }}
            </span>
          </div>
          <div :class="$style.meta">
            {{ offsetDays === 0 ? '今天抵达' : `+${offsetDays} 天后抵达` }} ·
            {{ fixed1(offsetBill?.weight ?? 0) }}t · {{ fixed1(offsetBill?.volume ?? 0) }}m³ ·
            {{ formatCost(offsetBill?.cost) }}
            <template v-if="offsetDelta !== undefined && offsetDelta !== 0">
              （<span :class="offsetDelta > 0 ? $style.amber : $style.green">
                {{ offsetDelta > 0 ? '+' : '' }}{{ formatCurrency(offsetDelta) }} </span
              >）
            </template>
          </div>
        </div>
      </div>
      <div v-if="selected" :class="[$style.panel, $style.cart]">
        <div :class="[$style.panelTitle, $style.cartTitle]">
          <span>购物清单 · {{ formatCost(offsetBill?.cost) }}</span>
          <div :class="$style.cartActions">
            <PrunButton
              dark
              inline
              :disabled="!selectedTypes.size || !offsetBill?.load?.length"
              data-tooltip="按已勾选类型的维修材料比价购买；自动扣除被维修基地仓库与所选交易所仓库的已有库存"
              data-tooltip-position="top"
              data-rp-repd-compare
              @click="onCompare"
              >比价购买</PrunButton
            >
          </div>
        </div>
        <div :class="$style.meta">
          {{ offsetDays === 0 ? '今天抵达' : `+${offsetDays} 天后抵达` }}
          · {{ fixed1(offsetBill?.weight ?? 0) }}t ·
          {{ fixed1(offsetBill?.volume ?? 0) }}m³<template v-if="settings.subtractStore"
            >，已扣基地库存</template
          >
          · 已选 {{ selectedTypes.size }} 类
        </div>
        <div v-if="!selectedTypes.size" :class="$style.meta" data-rp-repd-empty>
          在上方明细最左侧勾选要修的建筑类型，购物清单会随之更新。
        </div>
        <MaterialPurchaseTable :materials="offsetBill?.load ?? []" />
      </div>
    </div>
  </div>
</template>

<style module>
.layout {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 0.125rem 0.25rem;
  /* REPD 整体字号过小：根上比游戏原生基准 +2px。用 1em（= 继承来的基准）
     而不是写死 14px，换主题 / 换游戏字号时仍能稳定「加 2 个字号」。
     组件内其余 6 处 font-size 都是 em，会跟着一起等比放大。 */
  font-size: calc(1em + 2px);
}

/* 游戏原生 table / 单元格可能自带固定字号，逐层继承回根上的新基准，
   避免只有卡片文字变大、表格里仍旧是原字号。 */
.layout :global(table),
.layout :global(thead),
.layout :global(tbody),
.layout :global(tr),
.layout :global(th),
.layout :global(td) {
  font-size: inherit;
}

.overview {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  min-height: 0;
}

/* ── 维修设置栏（原 XIT SET → 维修）───────────────────────────────────
   独立成栏放在左栏最上方，横向自适应换行，尽量少占列表高度。
   字号略收一档，避免把 5 个选项挤成 4~5 行。 */
.settings {
  flex: 0 0 auto;
  font-size: 1em;
  border: 1px solid #2b485a;
  border-radius: 3px;
}

.settingsRows {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  padding: 3px 4px;
}

.settingItem {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.settingLabel {
  flex: 0 0 auto;
  color: #8a9aa8;
  white-space: nowrap;
}

/* 游戏原生 input/select 默认 175px，会把 5 个选项挤成一人一行。
   这里只在本设置栏内收窄，不影响看板其它地方与其它命令窗口。 */
.settings :global(input),
.settings :global(select) {
  box-sizing: border-box;
  min-width: 0;
  width: 64px;
}

.settings :global(select) {
  width: 116px;
}

.side {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
  min-height: 0;
}

/* ── 统计条 ── */
.stats {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.statCard {
  display: grid;
  min-width: 64px;
  padding: 2px 8px;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}

.statCard:hover {
  background-color: rgba(255, 255, 255, 0.06);
}

.statCardActive {
  border-color: #5aa9e6;
  background-color: rgba(90, 169, 230, 0.12);
}

.statBox {
  display: grid;
  padding: 2px 8px;
  border-left: 1px solid #2b485a;
}

.statLabel {
  font-size: 1em;
  color: #8a9aa8;
  white-space: nowrap;
}

.statValue {
  font-size: 1.15em;
  font-weight: bold;
  font-variant-numeric: tabular-nums;
}

.statNote {
  font-size: 1em;
  color: #8a9aa8;
  white-space: nowrap;
}

/* 阈值状态色：逾期红 / 即将到期橙 / 正常绿。走皮肤 token（每套主题各给自己的
   强调色），字面色值会被引擎按皮肤色相重映射成淡色，浅底上看不出差别（R45）。 */
.red {
  color: var(--rp-skin-danger, #9c3b3b);
}

.amber {
  color: var(--rp-skin-warning, #c2410c);
}

.green {
  color: var(--rp-skin-success, #2f6b48);
}

/* ── 列表 ── */
.listScroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.detail {
  flex: 0 0 auto;
}

.cart {
  flex: 1 1 0;
  margin-top: 0.5rem;
  border-top: 1px solid #2b485a;
  padding-top: 0.25rem;
}

.panelTitle {
  padding: 2px 4px;
  font-weight: bold;
  white-space: nowrap;
  border-bottom: 1px solid #2b485a;
}

.cartTitle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.meta {
  padding: 1px 4px;
  color: #8a9aa8;
  font-size: 1em;
  white-space: nowrap;
}

/* 偏移天数选择 */
.offsetRow {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 4px;
}

.offsetLabel {
  font-size: 1em;
  color: #8a9aa8;
  margin-right: 2px;
}

/* 「等待」合并到偏移行右侧：向左自动撑开，与偏移按钮拉开间距。 */
.waitInline {
  margin-left: auto;
  padding-left: 8px;
  font-size: 1em;
  color: #8a9aa8;
  white-space: nowrap;
}

.offsetBtn {
  padding: 0 5px;
  font-size: 1em;
  line-height: 16px;
  color: #bbbbbb;
  background: transparent;
  border: 1px solid #2b485a;
  border-radius: 3px;
  cursor: pointer;
}

.offsetBtn:hover {
  background-color: rgba(255, 255, 255, 0.08);
}

.offsetActive {
  border-color: #5aa9e6;
  color: #fff;
  background-color: rgba(90, 169, 230, 0.2);
}

/* 表格统一铺满所属面板，三个模块的表格宽度因此一致。 */
.compact,
.cart :global(table) {
  width: 100%;
  table-layout: auto;
}

.compact :global(th),
.compact :global(td) {
  padding: 0 4px;
  line-height: 1.35;
  white-space: nowrap;
}

.numeric {
  text-align: right;
}

/* 明细最左侧的维修勾选列：只占一个复选框宽，表头那个用于全选 / 清空。 */
.checkCol {
  width: 20px;
  text-align: center;
}

.checkCol :global(input[type='checkbox']) {
  margin: 0;
  vertical-align: middle;
  cursor: pointer;
}

/* 购物清单标题右侧的「比价购买」，紧贴标题、同一行。 */
.cartActions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

/* 明细表体固定 5 行高（表头 + 5 行数据），多出来的类型在框内滚动。 */
.detailBody {
  height: 110px;
  overflow: auto;
}

.detailBody :global(thead th) {
  position: sticky;
  top: 0;
  z-index: 1;
  background-color: #23282b;
}

.repairBar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 2px 4px;
}

.repairBar :global(button) {
  font-size: 14px;
}

.repairMsg {
  flex: 1 1 0;
  min-width: 0;
  font-size: 1em;
  color: #8a9aa8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 缺料表格：逐材料明细行（材料/需求/现有/缺口）。宽度随窗体流体变化
   （100% 填满面板，材料列吸收剩余空间）；高度固定预留区 84~168px，
   多材料在框内滚动，不与下方信息组抢高度。 */
.repairTableWrap {
  flex: 0 0 auto;
  width: 100%;
  box-sizing: border-box;
  min-height: 84px;
  max-height: 168px;
  overflow: auto;
  padding: 0 4px 2px;
  font-size: 1em;
}

.repairTable {
  width: 100%;
  table-layout: auto;
}

.repairTable :global(td),
.repairTable :global(th) {
  font-variant-numeric: tabular-nums;
}

.matTicker {
  color: #c9d4dd;
  font-weight: bold;
  width: 100%;
}

.matHave {
  color: #8a9aa8;
}

.matMiss {
  color: #f7a600;
}

.matOk {
  color: #5cb85c;
}

/* 偏移行 + 今天抵达 + 下方购物清单：一个信息组，整体下移约 2 行、
   顶边框标记组起点，组内的偏移/今天抵达与购物清单一起随布局下移。 */
.bottomGroup {
  flex: 0 0 auto;
  margin-top: 2.5em;
  padding-top: 2px;
  border-top: 1px solid #2b485a;
}

.empty {
  padding: 0.5rem;
  color: #8a9aa8;
}
</style>
