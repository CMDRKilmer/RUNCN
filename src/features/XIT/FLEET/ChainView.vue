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

const { ships, bases } = defineProps<{
  ships: DispatchShip[];
  bases: ChainPlannerBase[];
}>();

const chainShipId = useTileState<string | undefined>('chainShipId', undefined);
const chainRefuel = useTileState<boolean>('chainRefuel', true);
// 玩家自选参与环线的基地；未设置时默认全选。
const chainBaseIds = useTileState<string[] | undefined>('chainBaseIds', undefined);

const selectedBaseIds = computed(() => {
  if (chainBaseIds.value === undefined) {
    return bases.map(x => x.naturalId);
  }
  const present = new Set(bases.map(x => x.naturalId));
  return chainBaseIds.value.filter(id => present.has(id));
});

const selectedBases = computed(() =>
  bases.filter(x => selectedBaseIds.value.includes(x.naturalId)),
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
  chainBaseIds.value = bases.map(x => x.naturalId);
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

function formatLoad(stop: ChainStopPlan) {
  return [...stop.load.entries()]
    .map(([ticker, x]) => `${ticker}×${x.amount}(→${x.to})`)
    .join('、');
}

function formatDeficits(stop: ChainStopPlan) {
  return [...stop.deficits.entries()].map(([ticker, amount]) => `${ticker} 缺${amount}`).join('、');
}

const executeTooltip = computed(() => {
  if (!selectedShip.value) {
    return '请先选择执行环线的船只';
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
  const actionPlan = buildChainActionPackages(ship, p, { refuel: chainRefuel.value });
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
      <RadioItem v-model="chainRefuel" horizontal>加油</RadioItem>
      <div :class="$style.spacer" />
      <Tooltip v-if="executeTooltip" position="top" :tooltip="executeTooltip" no-icon>
        <PrunButton primary :disabled="!hasStops" @click="execute">执行环线</PrunButton>
      </Tooltip>
      <PrunButton v-else primary :disabled="!hasStops" @click="execute">执行环线</PrunButton>
    </div>

    <!-- Base selection -->
    <div v-if="bases.length > 0" :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <span :class="$style.baseBarLabel">基地</span>
      <RadioItem
        v-for="base in bases"
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
      的船只，勾选参与环线的基地，将根据基地产物推断产业链上下游，自动规划环线补给航线。
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
              <th :class="$style.narrowCol">星球</th>
              <th :class="$style.narrowCol">天数</th>
              <th>卸货（CX 采购）</th>
              <th>卸货（上游输送）</th>
              <th>提取（产物去向）</th>
              <th>缺口</th>
              <th :class="$style.narrowCol">限载</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(stop, i) in plan.stops" :key="stop.naturalId">
              <td :class="$style.narrowCol">{{ i + 1 }}</td>
              <td :class="$style.narrowCol">{{ stop.planetName }}</td>
              <td :class="$style.narrowCol">{{ fixed0(stop.days) }}</td>
              <td :class="$style.matCell">{{ formatMaterials(stop.unloadCx) || '—' }}</td>
              <td :class="$style.matCell">{{ formatUnloadChain(stop) || '—' }}</td>
              <td :class="$style.matCell">{{ formatLoad(stop) || '—' }}</td>
              <td :class="[$style.matCell, stop.deficits.size > 0 ? $style.deficit : '']">
                {{ formatDeficits(stop) || '—' }}
              </td>
              <td :class="$style.narrowCol">{{ stop.clipped ? '缩减' : '—' }}</td>
            </tr>
          </tbody>
        </table>

        <div :class="$style.summary">
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">CX 采购（{{ plan.originNaturalId }}）：</span>
            <span>{{ formatMaterials(plan.cxBill) || '无' }}</span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">归航卸货（最终产物）：</span>
            <span>{{ formatMaterials(plan.finalUnload) || '无' }}</span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">舱容峰值：</span>
            <span>
              {{ fixed0(plan.peakLoad.weight) }}t / 剩余 {{ fixed0(plan.freeCapacity.weight) }}t，
              {{ fixed0(plan.peakLoad.volume) }}m³ / 剩余 {{ fixed0(plan.freeCapacity.volume) }}m³
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

.deficit {
  color: #e8a33d;
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
