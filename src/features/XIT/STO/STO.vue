<script setup lang="ts">
import { BaseStorageAnalysis, getBaseStorageAnalysis } from '@src/core/storage-analysis';
import BaseHeader from '@src/features/XIT/STO/BaseHeader.vue';
import BaseSection from '@src/features/XIT/STO/BaseSection.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import InlineFlex from '@src/components/InlineFlex.vue';
import Tooltip from '@src/components/Tooltip.vue';
import { useTileState } from '@src/features/XIT/STO/tile-state';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { comparePlanets } from '@src/util';

// 假样本,用于不可见的参考行设置列宽。
const fakeAnalysis: BaseStorageAnalysis = {
  siteId: '',
  storeId: '',
  planetName: 'Placeholder',
  naturalId: '',
  weightCapacity: 1,
  weightLoad: 0.5,
  volumeCapacity: 1,
  volumeLoad: 0.5,
  importWeight: 0,
  importVolume: 0,
  exportWeight: 0,
  exportVolume: 0,
  fillPercentWeight: 0.5,
  fillPercentVolume: 0.5,
  fillPercentWeightNoInf: 0.5,
  fillPercentVolumeNoInf: 0.5,
  needFillPercentWeight: 0.5,
  needFillPercentVolume: 0.5,
  needFillRatio: 0.5,
  availableAfterShipOutWeight: 0.5,
  availableAfterShipOutVolume: 0.5,
  daysOfSuppliesFit: 10,
  suppliesReserveFraction: 0.2,
  daysUntilFull: 10,
  bindingLimit: 't',
};

const parameters = useXitParameters();
const expand = useTileState('expand');

const analyses = computed<BaseStorageAnalysis[] | undefined>(() => {
  if (!sitesStore.all.value) {
    return undefined;
  }
  let sites = sitesStore.all.value;
  if (parameters[0]) {
    const match = sitesStore.getByPlanetNaturalIdOrName(parameters[0]);
    sites = match ? [match] : [];
  }
  const result = sites.map(getBaseStorageAnalysis).filter((x): x is BaseStorageAnalysis => !!x);
  result.sort((a, b) => {
    const aInf = !isFinite(a.daysUntilFull);
    const bInf = !isFinite(b.daysUntilFull);
    // 非无限(填满中)的基地排在前面,按填满天数升序;排空中的基地按行星名升序排在末尾。
    if (aInf && bInf) {
      return a.planetName.localeCompare(b.planetName);
    }
    if (aInf !== bInf) {
      return aInf ? 1 : -1;
    }
    if (a.daysUntilFull !== b.daysUntilFull) {
      return a.daysUntilFull - b.daysUntilFull;
    }
    return comparePlanets(a.naturalId, b.naturalId);
  });
  return result;
});

watchEffect(() => {
  if (parameters[0] && analyses.value?.length === 1) {
    const naturalId = analyses.value[0].naturalId;
    if (!expand.value.includes(naturalId)) {
      expand.value = [...expand.value, naturalId];
    }
  }
});

const noMatch = computed(
  () => !!parameters[0] && analyses.value !== undefined && analyses.value.length === 0,
);
</script>

<template>
  <LoadingSpinner v-if="analyses === undefined" />
  <div v-else-if="noMatch" :class="$style.empty">未匹配基地 "{{ parameters[0] }}"</div>
  <div v-else-if="analyses.length === 0" :class="$style.empty">暂无基地</div>
  <table v-else>
    <thead>
      <tr>
        <th :class="$style.planet">行星</th>
        <th>
          <InlineFlex>
            填满天数
            <Tooltip
              position="bottom"
              tooltip="按当前净产出速率,距离仓储填满的天数 — 也是必须派船访问的临界点。" />
          </InlineFlex>
        </th>
        <th>
          <InlineFlex>
            供应天数
            <Tooltip
              position="bottom"
              tooltip="按当前装载阈值(填满中 80%,排空中 95%)出货后,基地能容纳的供应总天数。颜色与 XIT BURN 一致:低于红色阈值红色,低于黄色阈值黄色。" />
          </InlineFlex>
        </th>
        <th>
          <InlineFlex>
            当前填充
            <Tooltip position="bottom" tooltip="基地当前仓储的实际状态。按材料类别着色。" />
          </InlineFlex>
        </th>
        <th>
          <InlineFlex>
            补给后填充
            <Tooltip
              position="bottom"
              tooltip="假设所有产出物料运走、所有消耗物料按 XIT BURN 的 Need 量补足后的预计状态。红色斜纹表示超过容量的溢出。" />
          </InlineFlex>
        </th>
        <th>命令</th>
      </tr>
    </thead>
    <tbody :class="$style.fakeRow">
      <BaseHeader :analysis="fakeAnalysis" :on-click="() => {}" />
    </tbody>
    <BaseSection
      v-for="analysis in analyses"
      :key="analysis.siteId"
      can-minimize
      :analysis="analysis" />
  </table>
</template>

<style module>
.planet {
  text-align: left;
  padding-left: 26px;
}

.empty {
  padding: 1rem;
  font-style: italic;
  opacity: 0.7;
  text-align: center;
}

.fakeRow {
  visibility: collapse;
}
</style>
