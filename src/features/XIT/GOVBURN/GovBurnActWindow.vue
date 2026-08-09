<script setup lang="ts">
import ActionBar from '@src/components/ActionBar.vue';
import Active from '@src/components/forms/Active.vue';
import Header from '@src/components/Header.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import PrunButton from '@src/components/PrunButton.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { billTotals } from '@src/features/XIT/DISPATCH/utils';
import { popiBuildings } from '@src/features/XIT/GOVBURN/buildings';
import { stagedGovBurn } from '@src/features/XIT/GOVBURN/staged';
import {
  cogcRefills,
  planetGovBurnBill,
  rankSlots,
  type SlotPick,
} from '@src/features/XIT/GOVBURN/utils';
import { useMinBufferHeight } from '@src/hooks/use-min-buffer-height';
import { useTile } from '@src/hooks/use-tile';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { UI_TILES_CHANGE_COMMAND } from '@src/infrastructure/prun-api/client-messages';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { userData } from '@src/store/user-data';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, fixed02 } from '@src/utils/format';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const parameters = useXitParameters();
const tile = useTile();
useMinBufferHeight();

const parameter = computed(() => parameters.join(' '));

const naturalId = computed(() => {
  const planet = planetsStore.find(parameter.value);
  return planet?.naturalId ?? parameter.value;
});

const displayName = computed(() => {
  const captured = userData.govburn.planets[naturalId.value];
  return captured?.name ?? planetsStore.find(naturalId.value)?.name ?? naturalId.value;
});

const captured = computed(() => userData.govburn.planets[naturalId.value]);

const planetConfig = computed(() => userData.govburn.config.planets[naturalId.value] ?? {});

const canPlanResupply = computed(() => {
  const planet = captured.value;
  if (planet === undefined) {
    return false;
  }
  const config = planetConfig.value;
  const hasConfiguredBuildings = planet.buildings.some(
    x => x.level > 0 && (config[x.ticker] ?? 0) > 0,
  );
  return hasConfiguredBuildings || planet.cogc !== undefined;
});

const popiOrder = new Map(popiBuildings.map((x, i) => [x.ticker, i]));
const UNKNOWN_TICKER_ORDER = 999;

interface BuildingRow {
  ticker: string;
  level: number;
  n: number;
  hasUpkeeps: boolean;
}

const buildingRows = computed(() => {
  const planet = captured.value;
  if (planet === undefined) {
    return [] as BuildingRow[];
  }
  const config = planetConfig.value;
  const result: BuildingRow[] = [];
  for (const building of planet.buildings) {
    if (building.level <= 0) {
      continue;
    }
    const n = config[building.ticker] ?? 0;
    if (n <= 0) {
      continue;
    }
    result.push({
      ticker: building.ticker,
      level: building.level,
      n,
      hasUpkeeps: building.upkeeps !== undefined,
    });
  }
  result.sort(
    (a, b) =>
      (popiOrder.get(a.ticker) ?? UNKNOWN_TICKER_ORDER) -
      (popiOrder.get(b.ticker) ?? UNKNOWN_TICKER_ORDER),
  );
  return result;
});

// Keyed by building ticker; initialized once from rankSlots(building, n).
const slots = ref<Record<string, SlotPick[]>>({});

watch(
  () => [naturalId.value, captured.value, planetConfig.value] as const,
  () => {
    const planet = captured.value;
    if (planet === undefined) {
      slots.value = {};
      return;
    }
    const config = planetConfig.value;
    const next: Record<string, SlotPick[]> = {};
    for (const building of planet.buildings) {
      if (building.level <= 0) {
        continue;
      }
      const n = config[building.ticker] ?? 0;
      if (n <= 0 || building.upkeeps === undefined) {
        continue;
      }
      const previous = slots.value[building.ticker];
      if (
        previous !== undefined &&
        previous.length === Math.max(0, Math.min(n, building.upkeeps.length))
      ) {
        // Preserve user picks across data refreshes; blank tickers that are no longer upkeeps.
        const valid = new Set(building.upkeeps.map(x => x.ticker));
        next[building.ticker] = previous.map(x =>
          x.ticker === '' || valid.has(x.ticker) ? x : { ticker: '', source: 'manual' },
        );
      } else {
        next[building.ticker] = rankSlots(building, n);
      }
    }
    slots.value = next;
  },
  { immediate: true },
);

const dayOptions = ['5', '10', '15', '20', '25', '30'];

const resupplyDays = computed({
  get() {
    const days = userData.govburn.config.resupplyDays;
    if (typeof days === 'number' && dayOptions.includes(String(days))) {
      return String(days);
    }
    return '30';
  },
  set(value: string) {
    const days = Number(value);
    userData.govburn.config.resupplyDays = Number.isFinite(days) && days > 0 ? days : 30;
  },
});

const horizonDays = computed(() => Number(resupplyDays.value));

function slotOptions(buildingTicker: string, slotIndex: number) {
  const building = captured.value?.buildings.find(x => x.ticker === buildingTicker);
  const upkeeps = building?.upkeeps ?? [];
  const buildingSlots = slots.value[buildingTicker] ?? [];
  const usedByOthers = new Set(
    buildingSlots
      .filter((_, i) => i !== slotIndex)
      .map(x => x.ticker)
      .filter(x => x !== ''),
  );
  const available = upkeeps.map(x => x.ticker).filter(x => !usedByOthers.has(x));
  return ['', ...available];
}

function setSlot(buildingTicker: string, slotIndex: number, value: string | undefined) {
  const list = slots.value[buildingTicker];
  if (list === undefined) {
    return;
  }
  list[slotIndex] = { ticker: value ?? '', source: 'manual' };
}

const allResolved = computed(() => {
  for (const list of Object.values(slots.value)) {
    if (list.some(x => x.ticker === '')) {
      return false;
    }
  }
  return true;
});

const bill = computed(() => {
  const planet = captured.value;
  if (planet === undefined || !allResolved.value) {
    return {} as Record<string, number>;
  }
  return planetGovBurnBill(planet, slots.value, horizonDays.value, timestampEachMinute.value);
});

const billNotEmpty = computed(() => Object.keys(bill.value).length > 0);

const billLine = computed(() => {
  const parts = Object.entries(bill.value)
    .map(([ticker, amount]) => `${ticker} ${fixed0(amount)}`)
    .join(', ');
  const totals = billTotals(bill.value);
  return getI18nValue('RP.GOVBURN.act.billLine', 'Bill: ${parts} (${weight}t, ${volume}m³)')
    .replace('${parts}', parts)
    .replace('${weight}', fixed02(totals.weight))
    .replace('${volume}', fixed02(totals.volume));
});

const pkg = computed<UserData.ActionPackageData>(() => ({
  global: { name: `GovBurn Resupply ${naturalId.value}` },
  groups: [
    {
      type: 'Manual',
      name: 'GovBurn',
      planet: naturalId.value,
      materials: bill.value,
    },
  ],
  actions: [
    {
      type: 'CX Buy',
      name: 'CX Buy',
      group: 'GovBurn',
      exchange: configurableValue,
      useCXInv: true,
      skippable: true,
    },
    {
      type: 'MTRA',
      name: 'MTRA',
      group: 'GovBurn',
      origin: configurableValue,
      dest: configurableValue,
      sfcDestination: naturalId.value,
    },
  ],
}));

function onExecuteClick() {
  stagedGovBurn.value = { pkg: pkg.value };
  // Take over this tile instead of stranding the planner buffer behind the runner.
  if (!dispatchClientPrunMessage(UI_TILES_CHANGE_COMMAND(tile.id, null))) {
    showBuffer('XIT GOVBURNEXEC');
    return;
  }
  dispatchClientPrunMessage(UI_TILES_CHANGE_COMMAND(tile.id, 'XIT GOVBURNEXEC'));
}
</script>

<template>
  <div :class="$style.root">
    <Header :class="$style.header"
      >{{ getI18nValue('RP.GOVBURN.act.titlePrefix', 'GovBurn Resupply ')
      }}{{ displayName }}</Header
    >
    <template v-if="!captured">
      <p>
        {{
          getI18nValue('RP.GOVBURN.planetView.noData', 'No data for ${name}. Run').replace(
            '${name}',
            displayName,
          )
        }}
        <PrunLink inline :command="`XIT GOVBURNDATA ${naturalId}`">
          XIT GOVBURNDATA {{ naturalId }}
        </PrunLink>
        .
      </p>
    </template>
    <template v-else-if="!canPlanResupply">
      <p>
        {{
          getI18nValue(
            'RP.GOVBURN.act.noBuildings',
            'No buildings configured for ${name}. Configure them in',
          ).replace('${name}', displayName)
        }}
        <PrunLink inline command="XIT GOVBURN">XIT GOVBURN</PrunLink>
        .
      </p>
    </template>
    <template v-else>
      <div :class="$style.pane">
        <Active :label="getI18nValue('RP.GOVBURN.act.days', 'Days')">
          <SelectInput v-model="resupplyDays" :options="dayOptions" />
        </Active>

        <table v-if="buildingRows.length > 0">
          <thead>
            <tr>
              <th>{{ getI18nValue('RP.GOVBURN.act.building', 'Building') }}</th>
              <th v-for="i in Math.max(0, ...buildingRows.map(x => x.n))" :key="i"
                >{{ getI18nValue('RP.GOVBURN.act.slot', 'Slot') }} {{ i }}</th
              >
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in buildingRows" :key="row.ticker">
              <td>{{ row.ticker }} {{ row.level }}</td>
              <template v-if="!row.hasUpkeeps">
                <td :colspan="row.n" :class="$style.noData">{{
                  getI18nValue('RP.GOVBURN.act.noDataCell', 'no data')
                }}</td>
              </template>
              <template v-else>
                <td
                  v-for="(slot, index) in slots[row.ticker]"
                  :key="index"
                  :class="{ [$style.unresolved]: slot.ticker === '' }">
                  <div :class="[C.forms.input, $style.selectWrap]">
                    <SelectInput
                      :model-value="slot.ticker"
                      :options="slotOptions(row.ticker, index)"
                      @update:model-value="v => setSlot(row.ticker, index, v)" />
                  </div>
                </td>
              </template>
            </tr>
          </tbody>
        </table>

        <p v-if="captured?.cogc !== undefined" :class="$style.cogcSummary">
          {{
            getI18nValue('RP.GOVBURN.act.cogcSummary', 'COGC: ${count} refill(s) included').replace(
              '${count}',
              String(cogcRefills(horizonDays)),
            )
          }}
        </p>
      </div>
      <p v-if="allResolved && !billNotEmpty" :class="$style.summary">
        {{
          getI18nValue(
            'RP.GOVBURN.act.noBill',
            'Reserves already cover ${days} days — nothing to buy.',
          ).replace('${days}', String(horizonDays))
        }}
      </p>
      <template v-else>
        <p v-if="allResolved" :class="$style.summary">{{ billLine }}</p>
        <p v-else :class="$style.summary">{{
          getI18nValue('RP.GOVBURN.act.resolveSlots', 'Resolve all upkeep slots to continue.')
        }}</p>
      </template>
      <ActionBar :class="$style.actionBar">
        <PrunButton v-if="allResolved && billNotEmpty" primary @click="onExecuteClick">
          {{ getI18nValue('RP.GOVBURN.act.execute', 'EXECUTE') }}
        </PrunButton>
      </ActionBar>
    </template>
  </div>
</template>

<style module>
.root {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header {
  margin-left: 4px;
}

.pane {
  flex-grow: 1;
  margin-top: 5px;
  margin-left: 4px;
  padding: 4px;
  background-color: #23282b;
  border: 1px solid #2b485a;
}

.noData {
  color: rgb(217, 83, 79);
  font-style: italic;
}

.unresolved {
  color: rgb(217, 83, 79);
}

.selectWrap {
  width: 4.5rem;
  display: inline-block;
  vertical-align: middle;
}

.selectWrap :global(div) {
  width: 100%;
  margin-left: 0;
}

.summary {
  margin: 0.5rem 0 0.5rem 5px;
}

.cogcSummary {
  margin: 0.5rem 0 0;
  padding-left: 8px;
}

.actionBar {
  margin-left: 2px;
  justify-content: flex-start;
  user-select: none;
}
</style>
