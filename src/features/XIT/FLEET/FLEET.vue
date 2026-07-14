<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { timestampEachMinute } from '@src/utils/dayjs';
import { formatEta } from '@src/utils/format';

interface FleetRow {
  destination: string;
  destinationName: string;
  inTransit: number;
  docked: number;
  total: number;
  earliestArrival?: number;
  latestArrival?: number;
  lowCondition: number;
  needsRepair: number;
}

const rows = computed<FleetRow[] | undefined>(() => {
  const ships = shipsStore.all.value;
  const flights = flightsStore.all.value;
  if (!ships) {
    return undefined;
  }

  const byDestination = new Map<string, FleetRow>();

  function getRow(destinationId: string): FleetRow {
    let row = byDestination.get(destinationId);
    if (!row) {
      row = {
        destination: destinationId,
        destinationName: destinationId,
        inTransit: 0,
        docked: 0,
        total: 0,
        lowCondition: 0,
        needsRepair: 0,
      };
      byDestination.set(destinationId, row);
    }
    return row;
  }

  // 飞行中的飞船
  const shipFlightMap = new Map<string, PrunApi.Flight>();
  for (const flight of flights ?? []) {
    shipFlightMap.set(flight.shipId, flight);
    const ship = shipsStore.getById(flight.shipId);
    if (!ship) continue;
    const destId = getEntityNameFromAddress(flight.destination);
    if (!destId) continue;
    const row = getRow(destId);
    row.inTransit++;
    row.total++;
    const arrival = flight.arrival?.timestamp;
    if (arrival !== undefined) {
      if (row.earliestArrival === undefined || arrival < row.earliestArrival) {
        row.earliestArrival = arrival;
      }
      if (row.latestArrival === undefined || arrival > row.latestArrival) {
        row.latestArrival = arrival;
      }
    }
    if (ship.condition < 0.8) row.lowCondition++;
    if (ship.repairMaterials.length > 0) row.needsRepair++;
  }

  // 停靠中的飞船
  for (const ship of ships) {
    if (ship.flightId || !ship.address) continue;
    const destId = getEntityNameFromAddress(ship.address);
    if (!destId) continue;
    const row = getRow(destId);
    row.docked++;
    row.total++;
    if (ship.condition < 0.8) row.lowCondition++;
    if (ship.repairMaterials.length > 0) row.needsRepair++;
  }

  return Array.from(byDestination.values()).sort((a, b) => b.total - a.total);
});

function etaText(ms: number | undefined): string {
  if (ms === undefined) return '--';
  const now = timestampEachMinute.value;
  if (ms <= now) return '即将到达';
  return formatEta(now, ms);
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else>
    <thead>
      <tr>
        <th>目的地</th>
        <th>总数</th>
        <th>在途</th>
        <th>停靠</th>
        <th>最早到达</th>
        <th>最晚到达</th>
        <th>低状况</th>
        <th>需维修</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="8" style="text-align: center; opacity: 0.5; padding: 12px">暂无飞船数据</td>
      </tr>
      <tr v-for="row in rows" :key="row.destination">
        <td>
          <PrunLink inline :command="`FLT ${row.destination}`">{{ row.destinationName }}</PrunLink>
        </td>
        <td>{{ row.total }}</td>
        <td>{{ row.inTransit }}</td>
        <td>{{ row.docked }}</td>
        <td>{{ etaText(row.earliestArrival) }}</td>
        <td>{{ etaText(row.latestArrival) }}</td>
        <td :style="{ color: row.lowCondition > 0 ? '#f0ad4e' : '' }">
          {{ row.lowCondition > 0 ? row.lowCondition : '--' }}
        </td>
        <td :style="{ color: row.needsRepair > 0 ? '#d9534f' : '' }">
          {{ row.needsRepair > 0 ? row.needsRepair : '--' }}
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table tr > :not(:first-child) {
  text-align: right;
}
</style>
