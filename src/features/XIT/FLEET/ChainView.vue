<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import Tooltip from '@src/components/Tooltip.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import {
  planChainRoute,
  buildChainActionPackages,
  type ChainPlannerBase,
  type ChainStopPlan,
} from '@src/features/XIT/FLEET/chain-planner';
import type { DispatchShip } from '@src/features/XIT/FLEET/utils';
import { useTileState } from '@src/store/user-data-tiles';
import { userData } from '@src/store/user-data';
import { stagedDispatch } from '@src/features/XIT/FLEET/staged';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0 } from '@src/utils/format';

const props = defineProps<{
  ships: DispatchShip[];
  bases: ChainPlannerBase[];
}>();

const { ships, bases } = props;

const chainShipId = useTileState<string | undefined>('chainShipId', undefined);
// 环线模式下原「加油」按钮被「自动发船」取代：生成包时主包与每站包尾部
// 追加 DEPART 动作，跳过手动 SFC 确认（链上飞行仅需触发器推动）。
const chainAutoLaunch = useTileState<boolean>('chainAutoLaunch', true);
// 环线到港触发器模式：开启 → 生成 AUTO 触发器（到港自动卸货+提取+飞下一站），
// 关闭 → 生成 CONFIRM 触发器（到港通知确认后执行）。
const chainAutoTrigger = useTileState<boolean>('chainAutoTrigger', false);
// 环线基地范围：主界面（基地规划）分配给该船的基地；在此范围内可勾选/取消。
const chainBaseIds = useTileState<string[] | undefined>('chainBaseIds', undefined);

// 换船时重置勾选（新船默认全选其分配基地）。
watch(chainShipId, () => {
  chainBaseIds.value = undefined;
});

// 主界面分配给所选船的基地。
const assignedBases = computed(() => {
  const shipId = chainShipId.value;
  if (shipId === undefined) {
    return [];
  }
  return bases.filter(x => x.config.ship === shipId);
});

const selectedBaseIds = computed(() => {
  if (chainBaseIds.value === undefined) {
    return assignedBases.value.map(x => x.naturalId);
  }
  const present = new Set(assignedBases.value.map(x => x.naturalId));
  return chainBaseIds.value.filter(id => present.has(id));
});

const selectedBases = computed(() =>
  assignedBases.value.filter(x => selectedBaseIds.value.includes(x.naturalId)),
);

function setBaseSelected(id: string, selected: boolean) {
  const current = selectedBaseIds.value;
  if (selected) {
    chainBaseIds.value = current.includes(id) ? current : [...current, id];
  } else {
    chainBaseIds.value = current.filter(x => x !== id);
  }
}

function selectAllBases() {
  chainBaseIds.value = assignedBases.value.map(x => x.naturalId);
}

function clearAllBases() {
  chainBaseIds.value = [];
}

function shipLabel(entry: DispatchShip) {
  return entry.ship.name ?? entry.ship.registration;
}

// 环线派遣需要出发地仓库（加油/采购暂存）与船舱（装载），缺一不可。
const eligibleShips = computed(() =>
  ships
    .filter(x => x.warehouseStore && x.cargoStore)
    .sort((a, b) => shipLabel(a).localeCompare(shipLabel(b))),
);

const shipOptions = computed(() => [
  { label: '选择船只…', value: '' },
  ...eligibleShips.value.map(x => ({
    label: `${shipLabel(x)}（${x.exchangeCode}）`,
    value: x.ship.id,
  })),
]);

const shipSelect = computed({
  get: () => chainShipId.value ?? '',
  set: (v: string) => {
    chainShipId.value = v === '' ? undefined : v;
  },
});

const selectedShip = computed(() => eligibleShips.value.find(x => x.ship.id === chainShipId.value));

// 环线计划：产业链推断 + 航线 + 平衡运量 + 舱容模拟。
// burn 数据未加载时为 undefined（Loading 态）。
const plan = computed(() => {
  const ship = selectedShip.value;
  if (!ship) {
    return undefined;
  }
  return planChainRoute({ ship, bases: selectedBases.value });
});

const loading = computed(() => selectedShip.value !== undefined && plan.value === undefined);
const hasStops = computed(() => (plan.value?.stops.length ?? 0) > 0);

function formatMaterials(record: Record<string, number>) {
  return Object.entries(record)
    .filter(([, amount]) => amount > 0)
    .map(([ticker, amount]) => `${ticker}×${amount}`)
    .join('、');
}

function formatUnloadChain(stop: ChainStopPlan) {
  return [...stop.unloadChain.entries()]
    .map(([ticker, x]) => `${ticker}×${x.amount}(${x.from})`)
    .join('、');
}

// 卸货总明细：CX 采购 + 链上输送（含来源标注）。
function formatUnloadAt(stop: ChainStopPlan) {
  const cx = formatMaterials(stop.unloadCx);
  const chain = formatUnloadChain(stop);
  if (cx && chain) {
    return `${cx}、${chain}`;
  }
  return cx || chain;
}

// 本站之后的飞行目的地：下一站，末站回出发地。
function nextStopName(stops: ChainStopPlan[], i: number): string {
  return stops[i + 1]?.planetName ?? '出发地';
}

function formatLoad(stop: ChainStopPlan) {
  return [...stop.load.entries()]
    .map(([ticker, x]) => `${ticker}×${x.amount}(→${x.to})`)
    .join('、');
}

function formatLoadCell(
  load: { weight: number; volume: number },
  capacity: { weight: number; volume: number },
) {
  const wPct = capacity.weight > 0 ? Math.round((load.weight / capacity.weight) * 100) : 0;
  const vPct = capacity.volume > 0 ? Math.round((load.volume / capacity.volume) * 100) : 0;
  return `${fixed0(load.weight)}t ${wPct}%／${fixed0(load.volume)}m³ ${vPct}%`;
}

function formatLoadDelta(stop: ChainStopPlan) {
  const dw = stop.loadOnDeparture.weight - stop.loadOnArrival.weight;
  const dv = stop.loadOnDeparture.volume - stop.loadOnArrival.volume;
  const sign = (n: number) => (n > 0 ? `+${fixed0(n)}` : fixed0(n));
  const arrow = dw > 0 || dv > 0 ? '↑' : dw < 0 || dv < 0 ? '↓' : '·';
  return `${arrow} ${sign(dw)}t／${sign(dv)}m³`;
}

function formatPercent(value: number, capacity: number) {
  if (capacity <= 0) {
    return '0%';
  }
  return `${Math.round((value / capacity) * 100)}%`;
}

const executeTooltip = computed(() => {
  if (!selectedShip.value) {
    return '请先选择执行环线的船只';
  }
  if (assignedBases.value.length === 0) {
    return '该船在基地规划中未分配基地';
  }
  if (selectedBases.value.length === 0) {
    return '请勾选参与环线的基地';
  }
  return undefined;
});

function upsertPackage(pkg: UserData.ActionPackageData) {
  const index = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
  if (index >= 0) {
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
}

function upsertTrigger(trigger: UserData.TriggerData) {
  const index = userData.triggers.findIndex(
    x => x.packageName === trigger.packageName && x.event.type === 'FLIGHT_ENDED',
  );
  if (index >= 0) {
    userData.triggers[index] = trigger;
  } else {
    userData.triggers.push(trigger);
  }
}

function execute() {
  const ship = selectedShip.value;
  const p = plan.value;
  if (!ship || !p || p.stops.length === 0) {
    return;
  }
  const actionPlan = buildChainActionPackages(ship, p, {
    autoLaunch: chainAutoLaunch.value,
    triggerMode: chainAutoTrigger.value ? 'AUTO' : 'CONFIRM',
  });
  if (!actionPlan) {
    return;
  }
  // 主包（加油+采购+装载+飞往首站）暂存至 FLEETACT 确认执行。
  stagedDispatch.value = { pkg: JSON.parse(JSON.stringify(actionPlan.mainPkg)) };
  showBuffer('XIT FLEETACT');
  // 各站操作包 + FLIGHT_ENDED 触发器写入 userData，到港自动「卸货→提取→飞下一站」。
  for (const { pkg, trigger } of actionPlan.stopPkgs) {
    upsertPackage(pkg);
    upsertTrigger(trigger);
  }
  if (actionPlan.finalPkg) {
    upsertPackage(actionPlan.finalPkg.pkg);
    upsertTrigger(actionPlan.finalPkg.trigger);
  }
}
</script>

<template>
  <div :class="$style.layout">
    <div :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <SelectInput v-model="shipSelect" :options="shipOptions" :width="220" />
      <div :class="$style.separator" />
      <RadioItem v-model="chainAutoLaunch" horizontal>自动发船</RadioItem>
      <RadioItem v-model="chainAutoTrigger" horizontal>自动执行</RadioItem>
      <div :class="$style.spacer" />
      <Tooltip v-if="executeTooltip" position="top" :tooltip="executeTooltip" no-icon>
        <PrunButton primary :disabled="!hasStops" @click="execute">执行环线</PrunButton>
      </Tooltip>
      <PrunButton v-else primary :disabled="!hasStops" @click="execute">执行环线</PrunButton>
    </div>

    <!-- Base selection: 仅主界面分配给所选船的基地 -->
    <div
      v-if="selectedShip && assignedBases.length > 0"
      :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <span :class="$style.baseBarLabel">基地</span>
      <RadioItem
        v-for="base in assignedBases"
        :key="base.naturalId"
        :model-value="selectedBaseIds.includes(base.naturalId)"
        horizontal
        @update:model-value="selected => setBaseSelected(base.naturalId, selected)">
        {{ base.planetName || base.naturalId }}
      </RadioItem>
      <div :class="$style.separator" />
      <PrunButton dark @click="selectAllBases">全选</PrunButton>
      <PrunButton dark @click="clearAllBases">清空</PrunButton>
    </div>

    <div v-if="!selectedShip" :class="$style.hint">
      选择一艘停靠 CX
      的船只，将自动载入基地规划中分配给它的基地，并根据基地产物推断产业链上下游，自动规划环线补给航线。
    </div>
    <div v-else-if="assignedBases.length === 0" :class="$style.hint">
      该船在基地规划中未分配基地，请先在「基地规划」中把基地分配给这艘船。
    </div>
    <div v-else-if="selectedBases.length === 0" :class="$style.hint">请勾选参与环线的基地。</div>
    <LoadingSpinner v-else-if="loading" />
    <div v-else-if="plan" :class="$style.content">
      <template v-if="plan.stops.length > 0">
        <div :class="$style.route">
          <span :class="$style.routeLabel">航线：</span>
          <span :class="$style.routeOrigin">{{ plan.originNaturalId }}</span>
          <template v-for="stop in plan.stops" :key="stop.naturalId">
            <span :class="$style.routeArrow">→</span>
            <span :class="$style.routeNode">{{ stop.planetName }}</span>
          </template>
          <span :class="$style.routeArrow">→</span>
          <span :class="$style.routeOrigin">{{ plan.originNaturalId }}</span>
        </div>

        <table :class="$style.table">
          <thead>
            <tr>
              <th :class="$style.narrowCol">序</th>
              <th :class="$style.narrowCol">星球/空间站</th>
              <th>操作</th>
              <th>飞行</th>
              <th :class="$style.narrowCol">载重</th>
            </tr>
          </thead>
          <tbody>
            <!-- 行 0：出发地 采购 -->
            <tr>
              <td :class="$style.narrowCol">0</td>
              <td :class="$style.narrowCol">
                <span :class="$style.routeOrigin">{{ plan.originNaturalId }}</span>
              </td>
              <td :class="$style.matCell">
                <span :class="$style.opsLabel">采购</span>
                [{{ formatMaterials(plan.purchaseBill) || '无' }}]
              </td>
              <td :class="$style.matCell">
                → {{ plan.stops[0]?.planetName ?? plan.originNaturalId }}
              </td>
              <td :class="$style.narrowCol">{{
                formatLoadCell(plan.loadOnDeparture, plan.capacity)
              }}</td>
            </tr>
            <!-- 各站：卸货 + 取货 -->
            <tr v-for="(stop, i) in plan.stops" :key="stop.naturalId">
              <td :class="$style.narrowCol">{{ i + 1 }}</td>
              <td :class="$style.narrowCol">{{ stop.planetName }}</td>
              <td :class="$style.matCell">
                <div>
                  <span :class="$style.opsLabel">卸货</span>
                  [{{ formatUnloadAt(stop) || '无' }}]
                </div>
                <div>
                  <span :class="$style.opsLabel">取货</span>
                  [{{ formatLoad(stop) || '无' }}]
                </div>
                <span v-if="stop.clipped" :class="$style.opsWarn">（限载缩减）</span>
              </td>
              <td :class="$style.matCell"> → {{ nextStopName(plan.stops, i) }} </td>
              <td :class="$style.narrowCol">
                <div>{{ formatLoadCell(stop.loadOnDeparture, plan.capacity) }}</div>
                <div :class="$style.loadSub">{{ formatLoadDelta(stop) }}</div>
              </td>
            </tr>
            <!-- 末行：归航卸货 -->
            <tr>
              <td :class="$style.narrowCol">{{ plan.stops.length + 1 }}</td>
              <td :class="$style.narrowCol">
                <span :class="$style.routeOrigin">{{ plan.originNaturalId }}</span>
              </td>
              <td :class="$style.matCell">
                <span :class="$style.opsLabel">卸货</span>
                [{{ formatMaterials(plan.finalUnload) || '无' }}]
              </td>
              <td :class="$style.matCell">归航</td>
              <td :class="$style.narrowCol">{{
                formatLoadCell({ weight: 0, volume: 0 }, plan.capacity)
              }}</td>
            </tr>
          </tbody>
        </table>

        <div :class="$style.summary">
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">CX 采购（{{ plan.originNaturalId }}）：</span>
            <span>{{ formatMaterials(plan.purchaseBill) || '无' }}</span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">装船总账（含仓库库存装船）：</span>
            <span>{{ formatMaterials(plan.cxBill) || '无' }}</span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">归航卸货（最终产物）：</span>
            <span>{{ formatMaterials(plan.finalUnload) || '无' }}</span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">舱容峰值：</span>
            <span>
              {{ fixed0(plan.peakLoad.weight) }}t / 剩余 {{ fixed0(plan.freeCapacity.weight) }}t（
              {{ formatPercent(plan.peakLoad.weight, plan.capacity.weight) }} 重量），
              {{ fixed0(plan.peakLoad.volume) }}m³ / 剩余 {{ fixed0(plan.freeCapacity.volume) }}m³（
              {{ formatPercent(plan.peakLoad.volume, plan.capacity.volume) }} 体积）
            </span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">出发载重（装船后）：</span>
            <span>
              {{ fixed0(plan.loadOnDeparture.weight) }}t / {{ fixed0(plan.capacity.weight) }}t，
              {{ fixed0(plan.loadOnDeparture.volume) }}m³ / {{ fixed0(plan.capacity.volume) }}m³
            </span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">归航载重（卸货前）：</span>
            <span>
              {{ fixed0(plan.loadOnReturn.weight) }}t / {{ fixed0(plan.capacity.weight) }}t，
              {{ fixed0(plan.loadOnReturn.volume) }}m³ / {{ fixed0(plan.capacity.volume) }}m³
            </span>
          </div>
          <div v-for="warning in plan.warnings" :key="warning" :class="$style.warning">
            {{ warning }}
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style module>
.layout {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}

.filterBar {
  flex-wrap: wrap;
}

.filterBar :global(.SelectInput__container) {
  margin: 0;
}

.baseBarLabel {
  color: #8a9aa8;
  white-space: nowrap;
  margin-right: 0.25rem;
}

.separator {
  width: 1px;
  align-self: stretch;
  background-color: #2b485a;
  margin: 0 0.25rem;
}

.spacer {
  flex: 1;
}

.hint {
  padding: 8px;
  color: #8a9aa8;
}

.content {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.route {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.routeLabel {
  color: #8a9aa8;
}

.routeNode {
  color: rgb(171, 198, 128);
}

.routeOrigin {
  color: rgb(63, 162, 222);
}

.routeArrow {
  color: #8a9aa8;
}

.table {
  border-collapse: collapse;
  width: 100%;
}

.table thead tr {
  border-bottom: 1px solid #2b485a;
  box-sizing: border-box;
}

.table tbody tr {
  border-bottom: 1px solid #1d3341;
  box-sizing: border-box;
}

.table td,
.table th {
  padding: 3px 6px;
  text-align: left;
  vertical-align: top;
}

.narrowCol {
  white-space: nowrap;
}

.matCell {
  font-size: 11px;
}

.opsLabel {
  display: inline-block;
  min-width: 2.5em;
  color: #7ec8a3;
  font-weight: 600;
}

.opsWarn {
  color: #e8a33d;
  font-size: 10px;
}

.loadSub {
  font-size: 10px;
  color: #8a9aa8;
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.summaryRow {
  font-size: 11px;
}

.summaryLabel {
  color: #8a9aa8;
}

.warning {
  color: #e8a33d;
  font-size: 11px;
}
</style>
