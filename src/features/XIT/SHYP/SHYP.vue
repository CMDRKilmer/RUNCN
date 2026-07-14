<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { shipyardProjectsStore } from '@src/infrastructure/prun-api/data/shipyard-projects';
import { shipyardsStore } from '@src/infrastructure/prun-api/data/shipyards';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sumMaterialAmountPrice } from '@src/infrastructure/fio/cx';
import { timestampEachMinute } from '@src/utils/dayjs';
import { formatCurrency } from '@src/utils/format';
import { isEmpty } from 'ts-extras';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import $style from '../CONTS/conts-shared.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;

// 触发请求
shipyardProjectsStore.request();
shipyardsStore.getById(undefined);

const allProjects = computed(() => shipyardProjectsStore.all.value ?? []);

const startedProjects = computed(() =>
  allProjects.value
    .filter(p => p.status === 'STARTED')
    .sort((a, b) => (a.end?.timestamp ?? 0) - (b.end?.timestamp ?? 0)),
);

const createdProjects = computed(() =>
  allProjects.value
    .filter(p => p.status === 'CREATED')
    .sort((a, b) => a.creation.timestamp - b.creation.timestamp),
);

const builtProjects = computed(() =>
  allProjects.value
    .filter(p => p.status === 'BUILT')
    .sort((a, b) => (b.end?.timestamp ?? 0) - (a.end?.timestamp ?? 0)),
);

function blueprintName(p: PrunApi.ShipyardProject) {
  const bp = blueprintsStore.getByNaturalId(p.blueprintNaturalId);
  return bp?.name ?? p.blueprintNaturalId;
}

function shipyardLocation(p: PrunApi.ShipyardProject) {
  const sy = shipyardsStore.getById(p.shipyardId);
  return sy ? (getEntityNaturalIdFromAddress(sy.address) ?? '--') : '--';
}

// 投入材料总价值
function inventoryValue(p: PrunApi.ShipyardProject) {
  return sumMaterialAmountPrice(p.inventory.items) ?? 0;
}

// 蓝图物料清单总价值（用于计算投入进度）
function bomValue(p: PrunApi.ShipyardProject) {
  const bp = blueprintsStore.getByNaturalId(p.blueprintNaturalId);
  if (!bp) return 0;
  return sumMaterialAmountPrice(bp.billOfMaterial.quantities) ?? 0;
}

// 投入进度
function inventoryProgress(p: PrunApi.ShipyardProject) {
  const b = bomValue(p);
  if (b <= 0) return 0;
  return Math.min(1, inventoryValue(p) / b);
}

function progressClass(p: number) {
  if (p >= 0.5) return C.ColoredValue.positive;
  if (p > 0) return C.ColoredValue.negative;
  return '';
}

// STARTED 项目的完成 ETA
function etaText(p: PrunApi.ShipyardProject) {
  if (!p.end) return '--';
  const r = p.end.timestamp - timestampEachMinute.value;
  if (r <= 0) return '即将完成';
  const days = Math.floor(r / DAY_MS);
  const hours = Math.floor((r % DAY_MS) / (60 * 60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((r % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function etaStyle(p: PrunApi.ShipyardProject) {
  if (!p.end) return '';
  const r = p.end.timestamp - timestampEachMinute.value;
  if (r < DAY_MS) return 'color: #d9534f';
  if (r < DAY_MS * 3) return 'color: #f0ad4e';
  return '';
}

function statusLabel(p: PrunApi.ShipyardProject) {
  switch (p.status) {
    case 'CREATED':
      return p.canStart ? '可开工' : '待补料';
    case 'STARTED':
      return '建造中';
    case 'BUILT':
      return '已完工';
  }
}

function openShy(p: PrunApi.ShipyardProject) {
  void showBuffer(`SHY ${p.shipyardId.substring(0, 8)}`);
}

// 总投入价值
const totalInvested = computed(() =>
  allProjects.value.reduce((sum, p) => sum + inventoryValue(p), 0),
);
</script>

<template>
  <LoadingSpinner v-if="!shipyardProjectsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 建造中 -->
    <table>
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            🔨 建造中
            <span v-if="!isEmpty(startedProjects)" :class="$style.summary">
              共 {{ startedProjects.length }} 艘 | 总投入:
              {{ formatCurrency(totalInvested) }}
            </span>
          </th>
        </tr>
        <tr>
          <th>蓝图</th>
          <th>船厂</th>
          <th>状态</th>
          <th>材料进度</th>
          <th>投入价值</th>
          <th>完成 ETA</th>
          <th>完工时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(startedProjects)">
          <td colspan="7" :class="$style.empty">无建造中的项目</td>
        </tr>
        <tr v-for="p in startedProjects" :key="p.id">
          <td>{{ blueprintName(p) }}</td>
          <td>
            <span :class="C.Link.link" @click="openShy(p)">{{ shipyardLocation(p) }}</span>
          </td>
          <td>{{ statusLabel(p) }}</td>
          <td :class="progressClass(inventoryProgress(p))">
            {{ (inventoryProgress(p) * 100).toFixed(1) }}%
          </td>
          <td :class="C.ComExOrdersTable.number">{{ formatCurrency(inventoryValue(p)) }}</td>
          <td :style="etaStyle(p)">{{ etaText(p) }}</td>
          <td>{{ p.end ? new Date(p.end.timestamp).toLocaleDateString() : '--' }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 待开工 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            📋 待开工
            <span v-if="!isEmpty(createdProjects)" :class="$style.summary">
              共 {{ createdProjects.length }} 艘
            </span>
          </th>
        </tr>
        <tr>
          <th>蓝图</th>
          <th>船厂</th>
          <th>状态</th>
          <th>材料进度</th>
          <th>投入价值</th>
          <th>创建时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(createdProjects)">
          <td colspan="7" :class="$style.empty">无待开工项目</td>
        </tr>
        <tr v-for="p in createdProjects" :key="p.id">
          <td>{{ blueprintName(p) }}</td>
          <td>
            <span :class="C.Link.link" @click="openShy(p)">{{ shipyardLocation(p) }}</span>
          </td>
          <td :style="p.canStart ? 'color: #5cb85c' : 'color: #f0ad4e'">{{ statusLabel(p) }}</td>
          <td :class="progressClass(inventoryProgress(p))">
            {{ (inventoryProgress(p) * 100).toFixed(1) }}%
          </td>
          <td :class="C.ComExOrdersTable.number">{{ formatCurrency(inventoryValue(p)) }}</td>
          <td>{{ new Date(p.creation.timestamp).toLocaleDateString() }}</td>
          <td>
            <span :class="C.Link.link" @click="openShy(p)">前往</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 已完工 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            ✅ 已完工
            <span v-if="!isEmpty(builtProjects)" :class="$style.summary">
              共 {{ builtProjects.length }} 艘
            </span>
          </th>
        </tr>
        <tr>
          <th>蓝图</th>
          <th>船厂</th>
          <th>状态</th>
          <th>投入价值</th>
          <th>完工时间</th>
          <th>飞船 ID</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(builtProjects)">
          <td colspan="7" :class="$style.empty">无已完工项目</td>
        </tr>
        <tr v-for="p in builtProjects" :key="p.id">
          <td>{{ blueprintName(p) }}</td>
          <td>
            <span :class="C.Link.link" @click="openShy(p)">{{ shipyardLocation(p) }}</span>
          </td>
          <td>{{ statusLabel(p) }}</td>
          <td :class="C.ComExOrdersTable.number">{{ formatCurrency(inventoryValue(p)) }}</td>
          <td>{{ p.end ? new Date(p.end.timestamp).toLocaleDateString() : '--' }}</td>
          <td>{{ p.shipId ? p.shipId.substring(0, 8) : '--' }}</td>
          <td>
            <span
              v-if="p.shipId"
              :class="C.Link.link"
              @click="showBuffer(`SHPI ${p.shipId.substring(0, 8)}`)">
              查看
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
