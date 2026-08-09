<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import Tooltip from '@src/components/Tooltip.vue';
import InlineFlex from '@src/components/InlineFlex.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { userData } from '@src/store/user-data';
import { comparePlanets } from '@src/util';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

interface Row {
  siteId: string;
  naturalId: string;
  planetName: string;
}

const rows = computed<Row[] | undefined>(() => {
  if (!sitesStore.all.value) {
    return undefined;
  }
  const result: Row[] = [];
  for (const site of sitesStore.all.value) {
    const naturalId = getEntityNaturalIdFromAddress(site.address);
    const planetName = getEntityNameFromAddress(site.address);
    if (!naturalId || !planetName) {
      continue;
    }
    result.push({ siteId: site.siteId, naturalId, planetName });
  }
  result.sort((a, b) => comparePlanets(a.naturalId, b.naturalId));
  return result;
});

const defaultResupply = computed(() => userData.settings.burn.resupply);
const defaultThreshold = computed(() => userData.settings.repair.threshold);
const defaultOffset = computed(() => userData.settings.repair.offset);

function getResupplyOverride(naturalId: string) {
  return userData.settings.burn.planetResupply[naturalId];
}

function setResupplyOverride(naturalId: string, value: number | undefined) {
  const map = userData.settings.burn.planetResupply;
  if (value === undefined || isNaN(value)) {
    delete map[naturalId];
  } else {
    map[naturalId] = value;
  }
}

function getRepairOverride(naturalId: string) {
  return userData.settings.repair.planetOverrides[naturalId];
}

function setRepairField(
  naturalId: string,
  field: 'threshold' | 'offset',
  value: number | undefined,
) {
  const map = userData.settings.repair.planetOverrides;
  const entry = map[naturalId];
  if (value === undefined || isNaN(value)) {
    if (entry === undefined) {
      return;
    }
    delete entry[field];
    if (entry.threshold === undefined && entry.offset === undefined) {
      delete map[naturalId];
    }
  } else {
    if (entry === undefined) {
      map[naturalId] = { [field]: value };
    } else {
      entry[field] = value;
    }
  }
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <div v-else-if="rows.length === 0" :class="$style.empty">{{
    getI18nValue('RP.PLANETS.noBases', 'No bases yet')
  }}</div>
  <template v-else>
    <div :class="$style.note">
      Clear any field to remove its override and use the default value (from XIT SET / XIT REP).
    </div>
    <table :class="$style.table">
      <thead>
        <tr>
          <th :class="$style.planet">{{ getI18nValue('RP.PLANETS.planet', 'Planet') }}</th>
          <th>
            <InlineFlex>
              {{ getI18nValue('RP.PLANETS.resupplyDays', 'Resupply Days') }}
              <Tooltip
                position="bottom"
                :tooltip="`Per-planet override. Leave empty to use the default (${defaultResupply} days) from XIT SET.`" />
            </InlineFlex>
          </th>
          <th>
            <InlineFlex>
              {{ getI18nValue('RP.PLANETS.repairThreshold', 'Repair Threshold') }}
              <Tooltip
                position="bottom"
                :tooltip="`Per-planet override. Leave empty to use the default (${defaultThreshold} days) from XIT REP.`" />
            </InlineFlex>
          </th>
          <th>
            <InlineFlex>
              {{ getI18nValue('RP.PLANETS.repairOffset', 'Repair Offset') }}
              <Tooltip
                position="bottom"
                :tooltip="`Per-planet override. Leave empty to use the default (${defaultOffset} days) from XIT REP.`" />
            </InlineFlex>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.siteId" :class="$style.row">
          <td :class="$style.planet">{{ row.planetName }}</td>
          <td :class="$style.input">
            <NumberInput
              :model-value="getResupplyOverride(row.naturalId)"
              optional
              @update:model-value="setResupplyOverride(row.naturalId, $event)" />
          </td>
          <td :class="$style.input">
            <NumberInput
              :model-value="getRepairOverride(row.naturalId)?.threshold"
              optional
              @update:model-value="setRepairField(row.naturalId, 'threshold', $event)" />
          </td>
          <td :class="$style.input">
            <NumberInput
              :model-value="getRepairOverride(row.naturalId)?.offset"
              optional
              @update:model-value="setRepairField(row.naturalId, 'offset', $event)" />
          </td>
        </tr>
      </tbody>
    </table>
  </template>
</template>

<style module>
.table {
  width: 100%;
}

.planet {
  text-align: left;
  font-weight: bold;
  font-size: 12px;
  padding-left: 12px;
  white-space: nowrap;
}

.row {
  border-bottom: 1px solid #2b485a;
}

.input {
  width: 80px;
}

.input input {
  width: 100%;
  padding: 0 5px;
  background-color: #42361d;
  border-width: 0;
  border-bottom: 1px solid #8d6411;
  color: #cccccc;

  &:focus {
    outline: none;
  }
}

.empty {
  padding: 1rem;
  font-style: italic;
  opacity: 0.7;
  text-align: center;
}

.note {
  padding: 6px 8px;
  font-size: 12px;
  opacity: 0.85;
  background-color: rgba(100, 149, 237, 0.08);
  border-left: 3px solid #6495ed;
}
</style>
