<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import ExchangeSelector from '@src/components/forms/ExchangeSelector.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import Commands from '@src/components/forms/Commands.vue';
import { userData } from '@src/store/user-data';
import { calculatePlanetBurn, MaterialBurn } from '@src/core/burn';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { fixed2 } from '@src/utils/format';
import { persistedRef } from '@src/utils/persisted-ref';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

const parameters = useXitParameters();
const planetName = computed(() => parameters.join(' '));

const site = computed(() => sitesStore.getByPlanetNaturalIdOrName(planetName.value));

const burn = computed(() => {
  if (!site.value) {
    return undefined;
  }
  const id = site.value.siteId;
  const workforce = workforcesStore.getById(id)?.workforces;
  const production = productionStore.getBySiteId(id);
  const storage = storagesStore.getByAddressableId(id);
  if (!workforce || !production) {
    return undefined;
  }
  return {
    planetName: getEntityNameFromAddress(site.value.address) ?? planetName.value,
    burn: calculatePlanetBurn(production, workforce, storage ?? []),
  };
});

const days = persistedRef('genact-burn-days', 7);
const daysError = ref(false);
const includeConsumables = persistedRef('genact-burn-consumables', true);
const includeInputs = persistedRef('genact-burn-inputs', true);
const useBaseInv = persistedRef('genact-burn-base-inv', true);

// Exchange code to station name mapping.
const exchangeStationMap: Record<string, string> = {
  AI1: 'Antares Station',
  CI1: 'Benten Station',
  IC1: 'Hortus Station',
  NC1: 'Moria Station',
  CI2: 'Arclight Station',
  NC2: 'Hubur Station',
};

const exchanges = Object.keys(exchangeStationMap);
const exchange = persistedRef('genact-burn-exchange', exchanges[0]);

// Auto-derive warehouse name from selected exchange.
const warehouseName = computed(() => `${exchangeStationMap[exchange.value]} Warehouse`);

// ── 标准货箱填满 ──────────────────────────────────────────────
// 标准货箱容量（重量t / 体积m³），从大到小：
// LCB → WCB → HCB → VCB → MCB → SCB → VSC → TCB
const boxSizes: Record<string, { weight: number; volume: number }> = {
  LCB: { weight: 2000, volume: 2000 },
  WCB: { weight: 3000, volume: 1000 },
  HCB: { weight: 5000, volume: 5000 },
  VCB: { weight: 1000, volume: 3000 },
  MCB: { weight: 1000, volume: 1000 },
  SCB: { weight: 500, volume: 500 },
  VSC: { weight: 250, volume: 250 },
  TCB: { weight: 100, volume: 100 },
};
const boxSizeOptions = Object.keys(boxSizes);
const boxSize = persistedRef<string | undefined>('genact-burn-box', undefined);
const openSfc = persistedRef('genact-burn-sfc', false);
const genUnload = persistedRef('genact-burn-unload', true);

interface LoadResult {
  loadAmounts: Record<string, number>;
  weight: number;
  volume: number;
}

function getFilteredBurnData(): Record<string, MaterialBurn> {
  if (!burn.value) return {} as Record<string, MaterialBurn>;
  const consumablesOnly = includeConsumables.value && !includeInputs.value;
  let burnData = burn.value.burn;
  if (!useBaseInv.value && site.value) {
    const id = site.value.siteId;
    const wf = workforcesStore.getById(id)?.workforces;
    const prod = productionStore.getBySiteId(id);
    burnData = calculatePlanetBurn(consumablesOnly ? undefined : prod, wf, undefined);
  }
  return burnData;
}

function calcLoadAmounts(targetDays: number): LoadResult {
  const burnData = getFilteredBurnData();
  const loadAmounts: Record<string, number> = {};
  let totalWeight = 0;
  let totalVolume = 0;

  for (const ticker of Object.keys(burnData)) {
    const matBurn = burnData[ticker];
    if (matBurn.dailyAmount >= 0) continue;

    const consumablesOnly = includeConsumables.value && !includeInputs.value;
    if (consumablesOnly && matBurn.type !== 'workforce') continue;
    if (!consumablesOnly && !includeConsumables.value && matBurn.type === 'workforce') continue;

    const dailyConsume = -matBurn.dailyAmount;
    const inventory = matBurn.inventory;

    if (useBaseInv.value && inventory >= targetDays * dailyConsume) continue;

    const rawRequired = useBaseInv.value
      ? targetDays * dailyConsume - inventory
      : targetDays * dailyConsume;
    const required = Math.max(0, rawRequired);
    if (required <= 0) continue;

    const loadAmount = Math.ceil(required);
    loadAmounts[ticker] = loadAmount;

    const mat = materialsStore.getByTicker(ticker);
    if (mat) {
      totalWeight += mat.weight * loadAmount;
      totalVolume += mat.volume * loadAmount;
    }
  }

  return { loadAmounts, weight: totalWeight, volume: totalVolume };
}

// 卸货目标：星球基地仓库，锁定为 <星球名> Base（执行时不再配置）。
const unloadDest = computed(() => `${burn.value?.planetName ?? planetName.value} Base`);

// 选中标准货箱时自动计算最大天数（平衡天数）。
watch([boxSize, includeConsumables, includeInputs, useBaseInv], () => {
  const box = boxSize.value ? boxSizes[boxSize.value] : undefined;
  if (!box) return;
  const wCap = box.weight;
  const vCap = box.volume;

  if (wCap <= 0 || vCap <= 0) return;

  // 二分搜索最大平衡天数（支持小数）
  let lo = 1;
  let hi = 9999;
  let best = 1;
  let bestWeight = 0;
  let bestVolume = 0;

  // 进行小数精度的二分搜索
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    const { weight, volume } = calcLoadAmounts(mid);
    if (weight <= wCap && volume <= vCap) {
      best = mid;
      bestWeight = weight;
      bestVolume = volume;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // 尝试增加小数天数，找到更接近填满的组合
  let optimalDays = best;
  let optimalWeight = bestWeight;
  let optimalVolume = bestVolume;

  // 测试不同的小数增量，确保不超容
  const increments = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  for (const inc of increments) {
    const testDays = best + inc;
    const { weight, volume } = calcLoadAmounts(testDays);
    if (weight <= wCap && volume <= vCap) {
      const weightUtil = weight / wCap;
      const volumeUtil = volume / vCap;
      const totalUtil = (weightUtil + volumeUtil) / 2;

      const currentUtil = (optimalWeight / wCap + optimalVolume / vCap) / 2;

      if (totalUtil > currentUtil) {
        optimalDays = testDays;
        optimalWeight = weight;
        optimalVolume = volume;
      }
    }
  }

  // 最后验证一次，确保不超容
  let finalDays = optimalDays;
  let finalResult = calcLoadAmounts(finalDays);

  // 如果超容，逐步减少天数直到不超容
  while (finalResult.weight > wCap || finalResult.volume > vCap) {
    finalDays -= 0.1;
    if (finalDays < 1) break;
    finalResult = calcLoadAmounts(finalDays);
  }

  // 全面搜索最优解，尽可能填满容量
  let bestDays = finalDays;
  let bestUtilization = (finalResult.weight / wCap + finalResult.volume / vCap) / 2;

  // 搜索范围：从当前天数的0.9倍到1.1倍
  const searchStart = Math.max(1, finalDays * 0.9);
  const searchEnd = finalDays * 1.1;

  // 以0.001为步长进行全面搜索
  for (let testDays = searchStart; testDays <= searchEnd; testDays += 0.001) {
    const testResult = calcLoadAmounts(testDays);
    if (testResult.weight <= wCap && testResult.volume <= vCap) {
      const utilization = (testResult.weight / wCap + testResult.volume / vCap) / 2;
      if (utilization > bestUtilization) {
        bestDays = testDays;
        bestUtilization = utilization;
      }
    }
  }

  // 直接使用最佳天数，不进行四舍五入
  // 这样可以更精确地填满容量
  days.value = bestDays;
});

const packageName = computed(() => {
  const name = burn.value?.planetName ?? planetName.value;
  return `${name} Resupply ${days.value}d`;
});

// Calculate material bill for preview.
const materialBill = computed(() => {
  if (!burn.value || days.value <= 0) {
    return undefined;
  }
  const { loadAmounts } = calcLoadAmounts(days.value);
  return Object.keys(loadAmounts).length > 0 ? loadAmounts : undefined;
});

// Preview: total volume and weight.
const showPreview = ref(false);

const loadResult = computed(() => calcLoadAmounts(days.value));

const previewTotalWeight = computed(() => {
  if (!materialBill.value || days.value <= 0) {
    return 0;
  }
  return loadResult.value.weight;
});

const previewTotalVolume = computed(() => {
  if (!materialBill.value || days.value <= 0) {
    return 0;
  }
  return loadResult.value.volume;
});

function onPreviewClick() {
  if (days.value <= 0) {
    daysError.value = true;
    return;
  }
  daysError.value = false;
  showPreview.value = !showPreview.value;
}

function onGenerateClick() {
  if (days.value <= 0) {
    daysError.value = true;
    return;
  }

  const name = burn.value?.planetName ?? planetName.value;
  const groupName = 'Resupply';
  const consumablesOnly = includeConsumables.value && !includeInputs.value;

  const pkg: UserData.ActionPackageData = {
    global: { name: packageName.value },
    autoDelete: true,
    groups: [
      {
        type: 'Resupply',
        name: groupName,
        planet: name,
        days: days.value,
        useBaseInv: useBaseInv.value,
        consumablesOnly,
        includeConsumables: includeConsumables.value,
        includeInputs: includeInputs.value,
        exclusions: [],
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
        useCXInv: true,
      },
      {
        type: 'MTRA',
        name: 'Transfer to Ship',
        group: groupName,
        origin: warehouseName.value,
        dest: configurableValue,
      },
      ...(openSfc.value
        ? [
            {
              type: 'OPEN SFC' as const,
              name: 'Open Flight Controls',
              destination: burn.value?.planetName ?? planetName.value,
              shipSourceAction: 'Transfer to Ship',
            },
          ]
        : []),
    ],
  };

  // Overwrite existing package with same name, or push new one.
  const existing = userData.actionPackages.find(x => x.global.name === packageName.value);
  if (existing) {
    const index = userData.actionPackages.indexOf(existing);
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }

  // Auto-open the generated ACT execution window.
  showBuffer(`XIT ACT_${packageName.value.split(' ').join('_')}`);

  // 同时生成同名 Unload 卸货包：飞船到达星球后，把本次登船的物品
  // 从船上转移到星球仓库。物品清单用 Manual 组冻结生成时的账单，
  // 执行时 MTRA 会按船上实际载货量钳制。
  if (genUnload.value) {
    const unloadName = `${name} Unload`;
    // 卸货目标锁定为星球基地仓库 <星球名> Base（STORE 类型）；
    // 「从」执行时配置，且只列出飞船货舱（originType: SHIP_STORE）。
    const unloadPkg: UserData.ActionPackageData = {
      global: { name: unloadName },
      autoDelete: true,
      groups: [
        {
          type: 'Manual',
          name: 'Unload',
          materials: calcLoadAmounts(days.value).loadAmounts,
        },
      ],
      actions: [
        {
          type: 'MTRA',
          name: 'Unload',
          group: 'Unload',
          origin: configurableValue,
          dest: `${name} Base`,
          originType: 'SHIP_STORE',
        },
      ],
    };
    // 卸货包不自动打开执行窗口，只在 ACT 列表中等待执行。
    const existingUnload = userData.actionPackages.find(x => x.global.name === unloadName);
    if (existingUnload) {
      const index = userData.actionPackages.indexOf(existingUnload);
      userData.actionPackages[index] = unloadPkg;
    } else {
      userData.actionPackages.push(unloadPkg);
    }
  }
}
</script>

<template>
  <div v-if="!burn" :class="C.DraftConditionEditor.form">
    <SectionHeader>生成 ACT 补充包</SectionHeader>
    <div :class="$style.notice">在 {{ planetName }} 上没有找到基地。</div>
  </div>
  <div v-else :class="C.DraftConditionEditor.form">
    <SectionHeader>生成 ACT 补充包</SectionHeader>
    <form>
      <Active label="星球">
        <span>{{ burn.planetName }}</span>
      </Active>
      <Active label="补充天数" :error="daysError">
        <NumberInput v-model="days" />
      </Active>
      <Active label="消耗品" tooltip="包含劳动力消耗品（食物、饮料等）。">
        <RadioItem v-model="includeConsumables">消耗品</RadioItem>
      </Active>
      <Active label="生产原料" tooltip="包含生产线所需的输入原料。">
        <RadioItem v-model="includeInputs">生产原料</RadioItem>
      </Active>
      <Active label="使用基地库存" tooltip="计算补充量时是否将基地中现有材料计入。">
        <RadioItem v-model="useBaseInv">使用基地库存</RadioItem>
      </Active>
      <Active label="交易所" tooltip="选择交易所，仓库自动绑定对应空间站。">
        <ExchangeSelector v-model="exchange" :options="exchanges" />
      </Active>
      <Active
        label="标准货箱"
        tooltip="选择标准货箱，按容量自动计算能装多少天补给，填满飞船；再次点击取消选择。">
        <ExchangeSelector v-model="boxSize" :options="boxSizeOptions" deselectable />
      </Active>
      <Active label="打开航行控制" tooltip="转移完成后自动打开 SFC 并输入目的地。">
        <RadioItem v-model="openSfc">打开航行控制</RadioItem>
      </Active>
      <Active
        label="卸货包"
        tooltip="同时生成同名 Unload 包：飞船到达后把本次登船物品从船上转移到星球仓库。">
        <RadioItem v-model="genUnload">同时生成卸货包</RadioItem>
      </Active>
      <Active label="卸货目的地" tooltip="锁定为星球基地仓库（星球名 + Base）。">
        <span>{{ unloadDest }}</span>
      </Active>
      <Active label="仓库">
        <span>{{ warehouseName }}</span>
      </Active>
      <Active label="包名称">
        <span>{{ packageName }}</span>
      </Active>
      <Commands>
        <PrunButton primary @click="onGenerateClick">生成</PrunButton>
        <PrunButton primary @click="onPreviewClick">
          {{ showPreview ? '隐藏预览' : '预览' }}
        </PrunButton>
      </Commands>
    </form>
    <template v-if="showPreview && materialBill">
      <SectionHeader>预览</SectionHeader>
      <div :class="$style.preview">
        <Active label="总体积">
          <span>{{ fixed2(previewTotalVolume) }} m³</span>
        </Active>
        <Active label="总重量">
          <span>{{ fixed2(previewTotalWeight) }} t</span>
        </Active>
        <Active label="材料种类">
          <span>{{ Object.keys(materialBill).length }}</span>
        </Active>
      </div>
    </template>
  </div>
</template>

<style module>
.notice {
  padding: 8px 4px;
  color: rgb(217, 83, 79);
}

.preview {
  padding: 4px 0;
}
</style>
