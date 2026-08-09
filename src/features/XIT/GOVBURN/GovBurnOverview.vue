<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import GovBurnConfig from '@src/features/XIT/GOVBURN/GovBurnConfig.vue';
import GovBurnDaysCell from '@src/features/XIT/GOVBURN/GovBurnDaysCell.vue';
import { cogcDays, planetDays } from '@src/features/XIT/GOVBURN/utils';
import { store as planetContextMenu } from '@src/features/XIT/planet-context-menu';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { userData } from '@src/store/user-data';
import { comparePlanets } from '@src/util';
import { timestampEachMinute } from '@src/utils/dayjs';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const showConfig = ref(false);

interface PlanetRow {
  naturalId: string;
  name: string;
  days: number;
  hasData: boolean;
  cogcDays: number | undefined;
}

const rows = computed(() => {
  const now = timestampEachMinute.value;
  const result: PlanetRow[] = [];
  for (const naturalId of Object.keys(userData.govburn.config.planets)) {
    const config = userData.govburn.config.planets[naturalId] ?? {};
    const captured = userData.govburn.planets[naturalId];
    const planet = planetsStore.find(naturalId);
    const name =
      getEntityNameFromAddress(planet?.address) ?? captured?.name ?? planet?.name ?? naturalId;
    if (captured === undefined) {
      result.push({
        naturalId,
        name,
        days: Number.POSITIVE_INFINITY,
        hasData: false,
        cogcDays: undefined,
      });
      continue;
    }
    const popi = planetDays(captured, config, now);
    const cogc = captured.cogc !== undefined ? cogcDays(captured.cogc, now) : undefined;
    result.push({
      naturalId,
      name,
      days: popi.days,
      hasData: popi.hasData,
      cogcDays: cogc,
    });
  }
  result.sort((a, b) => {
    const aHasAny = a.hasData || a.cogcDays !== undefined;
    const bHasAny = b.hasData || b.cogcDays !== undefined;
    if (aHasAny !== bHasAny) {
      return aHasAny ? -1 : 1;
    }
    const aMin = Math.min(a.days, a.cogcDays ?? Number.POSITIVE_INFINITY);
    const bMin = Math.min(b.days, b.cogcDays ?? Number.POSITIVE_INFINITY);
    if (aMin !== bMin) {
      return aMin - bMin;
    }
    return comparePlanets(a.naturalId, b.naturalId);
  });
  return result;
});

function openPlanet(naturalId: string) {
  showBuffer(`XIT GOVBURN ${naturalId}`);
}

function onActClick(naturalId: string) {
  showBuffer(`XIT GOVBURNACT ${naturalId}`);
}
</script>

<template>
  <GovBurnConfig v-if="showConfig" @done="showConfig = false" />
  <template v-else>
    <div :class="C.ComExOrdersPanel.filter">
      <div :class="$style.spacer" />
      <PrunButton primary @click="showConfig = true">{{
        getI18nValue('RP.GOVBURN.overview.config', 'CONFIG')
      }}</PrunButton>
      <PrunButton primary @click="showBuffer('XIT GOVBURNDATA')">{{
        getI18nValue('RP.GOVBURN.overview.data', 'DATA')
      }}</PrunButton>
    </div>
    <p v-if="rows.length === 0" :class="$style.empty">{{
      getI18nValue('RP.GOVBURN.overview.noPlanets', 'No planets configured.')
    }}</p>
    <table v-else>
      <thead>
        <tr>
          <th>{{ getI18nValue('RP.GOVBURN.overview.planet', 'Planet') }}</th>
          <th>{{ getI18nValue('RP.GOVBURN.overview.popi', 'POPI') }}</th>
          <th>{{ getI18nValue('RP.GOVBURN.overview.cogc', 'COGC') }}</th>
          <th>{{ getI18nValue('RP.GOVBURN.overview.cmd', 'CMD') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.naturalId">
          <td
            :class="$style.planet"
            @click="openPlanet(row.naturalId)"
            @contextmenu.prevent="planetContextMenu.showMenu($event, row.naturalId)">
            {{ row.name }}
          </td>
          <td
            v-if="!row.hasData"
            :data-tooltip="
              getI18nValue(
                'RP.GOVBURN.overview.noPopi.tooltip',
                'No data captured. Run XIT GOVBURNDATA.',
              )
            "
            :class="$style.noData"
            @click="openPlanet(row.naturalId)">
            --
          </td>
          <GovBurnDaysCell v-else :days="row.days" :on-click="() => openPlanet(row.naturalId)" />
          <td
            v-if="row.cogcDays === undefined"
            :data-tooltip="
              getI18nValue(
                'RP.GOVBURN.overview.noCogc.tooltip',
                'No COGC data captured. Run XIT GOVBURNDATA.',
              )
            "
            :class="$style.noData"
            @click="openPlanet(row.naturalId)">
            --
          </td>
          <GovBurnDaysCell
            v-else
            :days="row.cogcDays"
            :on-click="() => openPlanet(row.naturalId)" />
          <td>
            <PrunButton dark inline @click="onActClick(row.naturalId)">{{
              getI18nValue('RP.GOVBURN.overview.act', 'ACT')
            }}</PrunButton>
          </td>
        </tr>
      </tbody>
    </table>
  </template>
</template>

<style module>
.spacer {
  flex: 1;
}

.empty {
  margin: 0.5rem 0;
}

.noData {
  cursor: pointer;
}

.planet {
  font-weight: bold;
  cursor: pointer;
}
</style>
