<script setup lang="ts">
import NumberInput from '@src/components/forms/NumberInput.vue';
import {
  calculateBuildingEntries,
  calculateShipEntries,
  getParameterShips,
  getParameterSites,
} from '@src/features/XIT/REP/entries';
import { timestampEachMinute } from '@src/utils/dayjs';
import { binarySearch } from '@src/utils/binary-search';
import dayjs from 'dayjs';
import { fixed1, percent1 } from '@src/utils/format';
import MaterialPurchaseTable from '@src/components/MaterialPurchaseTable.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { calcBuildingCondition } from '@src/core/buildings';
import { diffDays } from '@src/utils/time-diff';
import { userData } from '@src/store/user-data';
import { mergeMaterialAmounts } from '@src/core/sort-materials';
import SectionHeader from '@src/components/SectionHeader.vue';
import Tooltip from '@src/components/Tooltip.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import PrunLink from '@src/components/PrunLink.vue';
import { objectId } from '@src/utils/object-id';

const parameters = useXitParameters();

const sites = computed(() => getParameterSites(parameters));
const ships = computed(() => getParameterShips(parameters));

const isMultiTarget = computed(
  () => (sites.value?.length ?? 0) > 1 || (ships.value?.length ?? 0) > 0,
);

const buildingEntries = computed(() => calculateBuildingEntries(sites.value));
const shipEntries = computed(() => calculateShipEntries(ships.value));

const msInADay = dayjs.duration(1, 'day').asMilliseconds();

const currentSplitIndex = computed(() => {
  if (buildingEntries.value === undefined) {
    return undefined;
  }
  const settings = userData.settings.repair;
  const currentSplitDate =
    timestampEachMinute.value - settings.threshold * msInADay + settings.offset * msInADay;
  return binarySearch(currentSplitDate, buildingEntries.value, x => x.lastRepair);
});

const visibleBuildings = computed(() => {
  return buildingEntries.value?.slice(0, currentSplitIndex.value);
});

const visibleShips = computed(() => shipEntries.value?.filter(x => x.condition <= 0.85));

const materials = computed(() => {
  if (visibleBuildings.value === undefined || visibleShips.value === undefined) {
    return undefined;
  }
  const materials: PrunApi.MaterialAmount[] = [];
  const time = timestampEachMinute.value;
  for (const building of visibleBuildings.value) {
    const plannedRepairDate =
      (time - building.lastRepair) / msInADay + userData.settings.repair.offset;
    for (const { material, amount } of building.fullMaterials) {
      materials.push({
        material,
        amount: Math.ceil(amount * (1 - calcBuildingCondition(plannedRepairDate))),
      });
    }
  }
  materials.push(...visibleShips.value.flatMap(x => x.materials));
  return mergeMaterialAmounts(materials);
});

function calculateAge(lastRepair: number) {
  return diffDays(lastRepair, timestampEachMinute.value, true);
}
</script>

<template>
  <LoadingSpinner v-if="materials === undefined" />
  <template v-else>
    <div :class="$style.settings">
      <div :class="$style.settingItem">
        <span :class="[C.FormComponent.label, $style.settingLabel]">年龄阈值</span>
        <Tooltip
          position="bottom"
          tooltip="只把「上次维修后已超过这么多天」的建筑纳入清单；调小会带上更新的建筑，材料变多。" />
        <div :class="[C.FormComponent.input, C.forms.input, $style.settingInput]">
          <NumberInput v-model="userData.settings.repair.threshold" />
        </div>
      </div>
      <div :class="$style.settingItem">
        <span :class="[C.FormComponent.label, $style.settingLabel]">时间偏移</span>
        <Tooltip
          position="bottom"
          tooltip="按「再过这么多天」的损耗程度算材料，相当于 BRA 面板的 +24h / +48h 预览。" />
        <div :class="[C.FormComponent.input, C.forms.input, $style.settingInput]">
          <NumberInput v-model="userData.settings.repair.offset" />
        </div>
      </div>
    </div>
    <SectionHeader>购物车</SectionHeader>
    <MaterialPurchaseTable
      :collapsible="isMultiTarget"
      :collapsed-by-default="true"
      :materials="materials" />
    <SectionHeader>建筑</SectionHeader>
    <table>
      <thead>
        <tr>
          <th>代码</th>
          <th v-if="isMultiTarget">目标</th>
          <th>年龄（天）</th>
          <th>状况</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in visibleBuildings" :key="objectId(entry)">
          <td>{{ entry.ticker }}</td>
          <td v-if="isMultiTarget">
            <PrunLink :command="`XIT REP ${entry.naturalId}`">
              {{ entry.target }}
              <BaseAlias :natural-id="entry.naturalId" />
            </PrunLink>
          </td>
          <td>{{ fixed1(calculateAge(entry.lastRepair)) }}</td>
          <td>{{ percent1(entry.condition) }}</td>
        </tr>
        <tr v-for="entry in visibleShips" :key="objectId(entry)">
          <td>（飞船）</td>
          <td>{{ entry.target }}</td>
          <td>{{ fixed1(calculateAge(entry.lastRepair)) }}</td>
          <td>{{ percent1(entry.condition) }}</td>
        </tr>
      </tbody>
    </table>
  </template>
</template>

<style module>
/* 两项设置并成一行：每项各占半行（flex: 1 1 0），标签保持文字宽度、
   输入框吃掉该半行剩下的空间，窗口拉伸/收缩时两项同比例伸缩。
   颜色不写裸值，标签与输入框沿用游戏自身的表单类，主题换肤自动跟随。 */
.settings {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 12px;
  padding: 3px 4px;
}

.settingItem {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.settingLabel {
  flex: 0 0 auto;
  white-space: nowrap;
}

/* 提高一级特异性，压过游戏 forms.input 容器的默认宽度。 */
.settingItem > .settingInput {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}

/* 原生 <input> 默认按 size 撑到约 180px，会溢出容器，这里收回到容器宽度。 */
.settingItem > .settingInput input {
  width: 100%;
  min-width: 0;
}
</style>
