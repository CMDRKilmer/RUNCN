<script setup lang="ts">
import CopyButton from '@src/components/CopyButton.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import { BurnValues, getPlanetBurn, MaterialBurn, PlanetBurn } from '@src/core/burn';
import { comparePlanets } from '@src/util';
import BurnSection from '@src/features/XIT/BURN/BurnSection.vue';
import { useBurnTileState, useBurnFilters } from '@src/features/XIT/BURN/burn-state';
import Tooltip from '@src/components/Tooltip.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import MaterialRow from '@src/features/XIT/BURN/MaterialRow.vue';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { countDays, getSortedTickers } from '@src/features/XIT/BURN/utils';
import InlineFlex from '@src/components/InlineFlex.vue';
import { querySites } from '@src/features/XIT/shared/site-query';
import { isAuthenticated, reportProduction } from '@src/features/XIT/FACTION/use-faction-api';
import { userData } from '@src/store/user-data';

const parameters = useXitParameters();

// 用于整体消耗的虚拟基地。
const overall: PrunApi.Site = {} as PrunApi.Site;

const queryResult = computed(() => {
  if (!sitesStore.all.value) {
    return undefined;
  }

  return querySites(parameters, {
    includeOverall: true,
    overallSite: overall,
  });
});

const red = useBurnTileState('red');
const yellow = useBurnTileState('yellow');
const green = useBurnTileState('green');
const inf = useBurnTileState('inf');
const prod = useBurnTileState('prod');
const wf = useBurnTileState('wf');
const io = useBurnTileState('io');
const filters = useBurnFilters();

function filterBurn(burn: BurnValues): BurnValues {
  const filtered: BurnValues = {};
  for (const ticker of Object.keys(burn)) {
    const mat = burn[ticker];
    const hasProd = mat.input > 0 || mat.output > 0;
    const hasWf = mat.workforce > 0;
    if (!(hasProd && filters.value.prod) && !(hasWf && filters.value.wf)) {
      continue;
    }
    filtered[ticker] = mat;
  }
  return filtered;
}

const planetBurn = computed(() => {
  if (queryResult.value === undefined) {
    return undefined;
  }

  const filtered = queryResult.value.sites
    .filter(x => x !== overall)
    .map(getPlanetBurn)
    .filter(x => x !== undefined)
    .map(x => ({ ...x, burn: filterBurn(x.burn) }));
  if (filtered.length <= 1) {
    return filtered;
  }

  filtered.sort((a, b) => {
    const daysA = countDays(a.burn);
    const daysB = countDays(b.burn);
    if (daysA !== daysB) {
      return daysA - daysB;
    }
    return comparePlanets(a.naturalId, b.naturalId);
  });

  const overallBurn: BurnValues = {};
  for (const planet of filtered) {
    for (const ticker of Object.keys(planet.burn)) {
      const mat = planet.burn[ticker];
      overallBurn[ticker] ??= {
        input: 0,
        output: 0,
        workforce: 0,
        dailyAmount: 0,
        inventory: 0,
        daysLeft: 0,
        type: 'output',
      };
      overallBurn[ticker].input += mat.input;
      overallBurn[ticker].output += mat.output;
      overallBurn[ticker].workforce += mat.workforce;
      overallBurn[ticker].inventory += mat.inventory;
    }
  }

  for (const ticker of Object.keys(overallBurn)) {
    const mat = overallBurn[ticker];
    mat.dailyAmount = mat.output - mat.input - mat.workforce;
    if (mat.dailyAmount >= 0) {
      mat.daysLeft = 1000;
    } else {
      mat.daysLeft = -mat.inventory / mat.dailyAmount;
    }
  }

  const overallSection = { burn: overallBurn, planetName: '总览', naturalId: '', storeId: '' };

  if (queryResult.value.overallOnly) {
    return [overallSection];
  }
  const sections = filtered.slice();
  if (queryResult.value.includeOverall) {
    sections.push(overallSection);
  }
  return sections;
});

const fakeBurn: MaterialBurn = {
  dailyAmount: -100000,
  daysLeft: 10,
  inventory: 100000,
  type: 'input',
  input: 100000,
  output: 0,
  workforce: 0,
};

const rat = materialsStore.getByTicker('RAT')!;

const expand = useBurnTileState('expand');

const anyExpanded = computed(() => expand.value.length > 0);

function onExpandAllClick() {
  if (expand.value.length > 0) {
    expand.value = [];
  } else {
    expand.value = planetBurn.value?.map(x => x.naturalId) ?? [];
  }
}

// Exports all materials regardless of active color filters (RED/YELLOW/GREEN/INF)
// so spreadsheet users always get the complete dataset.
function formatBurnTable(burns: PlanetBurn[]) {
  const header =
    io.value === true
      ? '星球\t代号\t库存\t输入\t输出\t净变化\t天数'
      : '星球\t代号\t库存\t消耗/天\t天数';
  const lines = [header];
  for (const planet of burns) {
    const sorted = getSortedTickers(planet);
    for (const material of sorted) {
      const mat = planet.burn[material.ticker];
      // Floor needed here: per-planet burns are pre-floored, but overall burn is not.
      const days = mat.dailyAmount >= 0 ? '' : Math.floor(mat.daysLeft).toString();
      const burn = Math.round(mat.dailyAmount * 1000) / 1000;
      if (io.value === true) {
        const inAmt = Math.round((mat.input + mat.workforce) * 1000) / 1000;
        const outAmt = Math.round(mat.output * 1000) / 1000;
        lines.push(
          `${planet.planetName}\t${material.ticker}\t${mat.inventory}\t${inAmt}\t${outAmt}\t${burn}\t${days}`,
        );
      } else {
        lines.push(`${planet.planetName}\t${material.ticker}\t${mat.inventory}\t${burn}\t${days}`);
      }
    }
  }
  return lines.join('\n');
}

function copyBurnTable() {
  if (!planetBurn.value) {
    return '';
  }
  return formatBurnTable(planetBurn.value);
}

let uploadTimer: number | undefined;
let hasReportedThisRender = false;

watch(
  planetBurn,
  newVal => {
    if (hasReportedThisRender) return;
    if (!newVal) return;
    const overall = newVal.find(x => x.planetName === '总览');
    if (!overall) return;
    if (!isAuthenticated()) return;

    clearTimeout(uploadTimer);
    uploadTimer = window.setTimeout(() => {
      const items = Object.entries(overall.burn).map(([ticker, burnValue]) => ({
        ticker,
        quantity: Math.round(burnValue.dailyAmount),
      }));

      reportProduction(items)
        .then(() => {
          hasReportedThisRender = true;
          const today = new Date().toISOString().slice(0, 10);
          userData.lastAutoProductionDate = today;
        })
        .catch(console.error);
    }, 3000);
  },
  { deep: true },
);
</script>

<template>
  <LoadingSpinner v-if="planetBurn === undefined" />
  <template v-else>
    <div :class="C.ComExOrdersPanel.filter">
      <RadioItem v-model="red" horizontal>红色</RadioItem>
      <RadioItem v-model="yellow" horizontal>黄色</RadioItem>
      <RadioItem v-model="green" horizontal>绿色</RadioItem>
      <RadioItem v-model="inf" horizontal>无限</RadioItem>
      <div :class="$style.separator" />
      <RadioItem
        v-model="prod"
        horizontal
        :class="$style.radioItemWithTooltip"
        data-tooltip="切换生产消耗的材料。关闭时，仅隐藏生产中使用的材料。"
        data-tooltip-position="bottom">
        生产
      </RadioItem>
      <RadioItem
        v-model="wf"
        horizontal
        :class="$style.radioItemWithTooltip"
        data-tooltip="切换劳动力消耗的材料。关闭时，仅隐藏劳动力消耗的材料。"
        data-tooltip-position="bottom">
        劳动力
      </RadioItem>
      <div :class="$style.separator" />
      <RadioItem v-model="io" horizontal>I/O</RadioItem>
      <div :class="$style.spacer" />
      <CopyButton :copy-fn="copyBurnTable" data-tooltip-position="bottom" />
    </div>
    <table>
      <thead>
        <tr>
          <th v-if="planetBurn.length > 1" :class="$style.expand" @click="onExpandAllClick">
            {{ anyExpanded ? '-' : '+' }}
          </th>
          <th v-else />
          <th>库存</th>
          <template v-if="io">
            <th>输入</th>
            <th>输出</th>
            <th>净变化</th>
          </template>
          <th v-else>
            <InlineFlex>
              消耗
              <Tooltip position="bottom" tooltip="每天消耗的材料量。" />
            </InlineFlex>
          </th>
          <th>
            <InlineFlex>
              需要
              <Tooltip position="bottom" tooltip="需要补给的材料量以实现完全供应。" />
            </InlineFlex>
          </th>
          <th>天数</th>
          <th>命令</th>
        </tr>
      </thead>
      <tbody :class="$style.fakeRow">
        <MaterialRow always-visible :burn="fakeBurn" :material="rat" />
      </tbody>
      <BurnSection
        v-for="burn in planetBurn"
        :key="burn.planetName"
        :can-minimize="planetBurn.length > 1"
        :burn="burn" />
    </table>
  </template>
</template>

<style module>
.fakeRow {
  visibility: collapse;
}

.spacer {
  flex: 1;
}

.separator {
  width: 1px;
  align-self: stretch;
  background-color: #2b485a;
  margin: 0 0.25rem;
}

.expand {
  text-align: center;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  padding-left: 18px;
  font-weight: bold;
}

.radioItemWithTooltip {
  padding: 0;
}
</style>
