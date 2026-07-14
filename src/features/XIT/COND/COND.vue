<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { sitesStore, getBuildingLastRepair } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { isRepairableBuilding } from '@src/core/buildings';
import { sumMaterialAmountPrice } from '@src/infrastructure/fio/cx';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, formatCurrency } from '@src/utils/format';
import { isEmpty } from 'ts-extras';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import $style from '../CONTS/conts-shared.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const FLOOR_DAYS = 180; // 180 天从 100% 衰减到 0%（即 33% 效率地板）

interface BuildingRow {
  site: PrunApi.Site;
  building: PrunApi.Platform;
  planetName: string;
  condition: number;
  daysSinceRepair: number;
  daysUntilFloor: number;
  repairCost: number | undefined;
}

// 收集所有可维修建筑
const rows = computed<BuildingRow[]>(() => {
  const sites = sitesStore.all.value ?? [];
  const out: BuildingRow[] = [];
  for (const site of sites) {
    const planetName = getEntityNaturalIdFromAddress(site.address) ?? '--';
    for (const building of site.platforms) {
      if (!isRepairableBuilding(building)) continue;
      const lastRepair = getBuildingLastRepair(building);
      const daysSinceRepair = (timestampEachMinute.value - lastRepair) / DAY_MS;
      // condition = 1 - age/180，故 daysUntilFloor = condition * 180
      const daysUntilFloor = building.condition * FLOOR_DAYS;
      const repairCost = sumMaterialAmountPrice(building.repairMaterials);
      out.push({
        site,
        building,
        planetName,
        condition: building.condition,
        daysSinceRepair,
        daysUntilFloor,
        repairCost,
      });
    }
  }
  // 按触底剩余天数升序，最紧急的在前
  out.sort((a, b) => a.daysUntilFloor - b.daysUntilFloor);
  return out;
});

// 紧急：触底 < 7 天；警告：< 14 天
function urgencyStyle(r: BuildingRow) {
  if (r.daysUntilFloor < 7) return 'color: #d9534f';
  if (r.daysUntilFloor < 14) return 'color: #f0ad4e';
  return '';
}

function conditionStyle(c: number) {
  if (c <= 0.2) return 'color: #d9534f';
  if (c <= 0.5) return 'color: #f0ad4e';
  return 'color: #5cb85c';
}

function conditionClass(c: number) {
  if (c >= 0.5) return C.ColoredValue.positive;
  if (c > 0) return C.ColoredValue.negative;
  return '';
}

function etaText(r: BuildingRow) {
  if (r.daysUntilFloor <= 0) return '已触底';
  const days = Math.floor(r.daysUntilFloor);
  const hours = Math.floor((r.daysUntilFloor - days) * 24);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

function lastRepairText(r: BuildingRow) {
  const ts = getBuildingLastRepair(r.building);
  return new Date(ts).toLocaleDateString();
}

// 全部维修总成本
const totalRepairCost = computed(() => {
  let sum = 0;
  let hasUndefined = false;
  for (const r of rows.value) {
    if (r.repairCost === undefined) {
      hasUndefined = true;
      continue;
    }
    sum += r.repairCost;
  }
  return hasUndefined ? undefined : sum;
});

// 紧急维修成本（触底 < 7 天）
const urgentRepairCost = computed(() => {
  let sum = 0;
  let hasUndefined = false;
  for (const r of rows.value) {
    if (r.daysUntilFloor >= 7) continue;
    if (r.repairCost === undefined) {
      hasUndefined = true;
      continue;
    }
    sum += r.repairCost;
  }
  return hasUndefined ? undefined : sum;
});

function openREP(planet: string) {
  void showBuffer(`REP ${planet}`);
}

function openBBL(planet: string) {
  void showBuffer(`BBL ${planet}`);
}
</script>

<template>
  <LoadingSpinner v-if="!sitesStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 汇总 -->
    <div :class="$style.totalsBar">
      <span>
        可维修建筑: <strong>{{ rows.length }}</strong>
      </span>
      <span v-if="totalRepairCost !== undefined">
        全部维修成本: <strong :class="$style.payable">{{ formatCurrency(totalRepairCost) }}</strong>
      </span>
      <span v-if="urgentRepairCost !== undefined">
        紧急维修成本 (≤7d):
        <strong style="color: #d9534f">{{ formatCurrency(urgentRepairCost) }}</strong>
      </span>
    </div>

    <table>
      <thead>
        <tr>
          <th>星球</th>
          <th>建筑</th>
          <th>类型</th>
          <th>当前状况</th>
          <th>已修后天数</th>
          <th>触底剩余</th>
          <th>维修成本</th>
          <th>上次维修</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(rows)">
          <td colspan="9" :class="$style.empty">无可维修建筑</td>
        </tr>
        <tr v-for="r in rows" :key="r.building.id">
          <td>
            <span :class="C.Link.link" @click="openBBL(r.planetName)">{{ r.planetName }}</span>
          </td>
          <td>{{ r.building.module.reactorName }}</td>
          <td>{{ r.building.module.type === 'RESOURCES' ? '资源' : '生产' }}</td>
          <td :class="conditionClass(r.condition)" :style="conditionStyle(r.condition)">
            {{ (r.condition * 100).toFixed(1) }}%
          </td>
          <td :class="C.ComExOrdersTable.number">{{ fixed0(r.daysSinceRepair) }}d</td>
          <td :style="urgencyStyle(r)" :class="C.ComExOrdersTable.number">{{ etaText(r) }}</td>
          <td :class="[$style.payable, C.ComExOrdersTable.number]">
            {{ r.repairCost !== undefined ? formatCurrency(r.repairCost) : '--' }}
          </td>
          <td>{{ lastRepairText(r) }}</td>
          <td>
            <span :class="C.Link.link" @click="openREP(r.planetName)">维修</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
