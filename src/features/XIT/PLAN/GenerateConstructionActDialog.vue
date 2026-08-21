<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import { userData } from '@src/store/user-data';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fioBuildingsStore, loadFioBuildings } from '@src/features/XIT/PLAN/fio-buildings';
import type { PlannedBuilding } from '@src/features/XIT/PLAN/tile-state';

const { plan } = defineProps<{ plan: UserData.BasePlan }>();

interface PlanetEnv {
  gravity: number;
  temperature: number;
  pressure: number;
  surface: boolean;
}

const exchangeStationMap: Record<string, string> = {
  AI1: 'Antares Station',
  CI1: 'Benten Station',
  IC1: 'Hortus Station',
  NC1: 'Moria Station',
  CI2: 'Arclight Station',
  NC2: 'Hubur Station',
};
const exchanges = Object.keys(exchangeStationMap);

const exchange = ref(plan.exchange && exchanges.includes(plan.exchange) ? plan.exchange : 'IC1');
const useCXInv = ref(true);

const planetEnv = ref<PlanetEnv | undefined>();

void loadFioBuildings();

// 星球环境建材与 PLAN 面板同一套规则（MCG/AEF、重力、气压、温度）。
function envMaterials(areaCost: number, env: PlanetEnv): Record<string, number> {
  const mats: Record<string, number> = {};
  if (env.surface) {
    mats['MCG'] = areaCost * 4;
  } else {
    mats['AEF'] = Math.ceil(areaCost / 3);
  }
  if (env.gravity < 0.25) {
    mats['MGC'] = 1;
  } else if (env.gravity > 2.5) {
    mats['BL'] = 1;
  }
  if (env.pressure < 0.25) {
    mats['SEA'] = areaCost;
  } else if (env.pressure > 2.0) {
    mats['HSE'] = 1;
  }
  if (env.temperature < -25) {
    mats['INS'] = areaCost * 10;
  } else if (env.temperature > 75) {
    mats['TSH'] = 1;
  }
  return mats;
}

async function fetchPlanetEnv() {
  if (!plan.planet) {
    return;
  }
  try {
    const resp = await fetch(`https://rest.fnar.net/planet/${encodeURIComponent(plan.planet)}`);
    if (!resp.ok) {
      return;
    }
    const data = await resp.json();
    planetEnv.value = {
      gravity: data.Gravity as number,
      temperature: data.Temperature as number,
      pressure: data.Pressure as number,
      surface: data.Surface as boolean,
    };
  } catch {
    // 环境数据获取失败时仅按基础建材生成。
  }
}
void fetchPlanetEnv();

const buildingCount = (pb: PlannedBuilding) =>
  pb.count !== 0 ? pb.count : pb.recipes.reduce((sum, r) => sum + r.count, 0);

// 汇总计划建筑所需建材（基础 + 环境）。
const materials = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {};
  const buildings = fioBuildingsStore.buildings;
  if (!buildings) {
    return result;
  }
  for (const pb of plan.buildings as PlannedBuilding[]) {
    const fb = buildings.find(x => x.Ticker === pb.ticker);
    if (!fb) {
      continue;
    }
    const count = buildingCount(pb);
    for (const cost of fb.BuildingCosts) {
      if (!cost.CommodityTicker) {
        continue;
      }
      result[cost.CommodityTicker] = (result[cost.CommodityTicker] ?? 0) + cost.Amount * count;
    }
    if (planetEnv.value) {
      for (const [ticker, amount] of Object.entries(envMaterials(fb.AreaCost, planetEnv.value))) {
        result[ticker] = (result[ticker] ?? 0) + amount * count;
      }
    }
  }
  return result;
});

const sortedMaterials = computed(() =>
  Object.entries(materials.value).sort((a, b) => a[0].localeCompare(b[0])),
);

const packageName = computed(() => `GOUCAI${plan.planet ? `_${plan.planet}` : ''}`);
const warehouseName = computed(() => `${exchangeStationMap[exchange.value]} Warehouse`);

function onGenerateClick() {
  const groupName = 'Construction';
  const pkg: UserData.ActionPackageData = {
    global: { name: packageName.value },
    groups: [
      {
        type: 'Manual',
        name: groupName,
        materials: { ...materials.value },
      },
    ],
    actions: [
      {
        type: 'CX Buy',
        name: 'CX Buy',
        group: groupName,
        exchange: exchange.value,
        buyPartial: false,
        allowUnfilled: false,
        useCXInv: useCXInv.value,
      },
      {
        type: 'MTRA',
        name: 'Transfer to Base',
        group: groupName,
        origin: warehouseName.value,
        dest: configurableValue,
      },
    ],
  };

  const existing = userData.actionPackages.find(x => x.global.name === packageName.value);
  if (existing) {
    const index = userData.actionPackages.indexOf(existing);
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
  showBuffer(`XIT ACT_${packageName.value}`);
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>生成建造购材 ACT 包</SectionHeader>
    <div v-if="fioBuildingsStore.loading" :class="$style.notice">正在载入建筑数据...</div>
    <div v-else-if="fioBuildingsStore.error" :class="$style.notice">
      建筑数据加载失败，无法连接 FIO。
    </div>
    <div v-else-if="sortedMaterials.length === 0" :class="$style.notice">
      计划中没有可识别的建筑。
    </div>
    <form v-else>
      <Active label="计划">
        <span>{{ plan.name }}（{{ plan.planet || '未指定星球' }}）</span>
      </Active>
      <Active label="交易所">
        <SelectInput v-model="exchange" :options="exchanges" />
      </Active>
      <Active label="扣除 CX 库存" tooltip="购买时扣除交易所仓库中已有的材料数量。">
        <RadioItem v-model="useCXInv">扣除 CX 仓库已有库存</RadioItem>
      </Active>
      <div :class="$style.materials">
        <SectionHeader>建材清单</SectionHeader>
        <table>
          <thead>
            <tr>
              <th>材料</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[ticker, amount] in sortedMaterials" :key="ticker">
              <td>{{ ticker }}</td>
              <td>{{ amount }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Commands>
        <PrunButton primary @click="onGenerateClick">生成</PrunButton>
      </Commands>
    </form>
  </div>
</template>

<style module>
.notice {
  margin: 8px;
}

.materials {
  max-height: 220px;
  overflow-y: auto;
  margin-top: 8px;
}
</style>
