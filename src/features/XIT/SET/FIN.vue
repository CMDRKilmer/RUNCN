<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import Tooltip from '@src/components/Tooltip.vue';
import Commands from '@src/components/forms/Commands.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { fixed0, hhmm, ddmmyyyy } from '@src/utils/format';
import { clearBalanceHistory, userData } from '@src/store/user-data';
import { calcEquity } from '@src/core/balance/balance-sheet-summary';
import { showConfirmationOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import {
  balanceHistory,
  canCollectFinDataPoint,
  collectFinDataPoint,
} from '@src/store/user-data-balance';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { objectId } from '@src/utils/object-id';
import RadioItem from '@src/components/forms/RadioItem.vue';

const sortedData = computed(() => balanceHistory.value.slice().reverse());

function confirmDataPointDelete(ev: Event, index: number) {
  index = balanceHistory.value.length - index - 1;
  showConfirmationOverlay(ev, () => deleteBalanceHistoryDataPoint(index), {
    message: `你即将删除一个历史数据点。是否继续？`,
  });
}

function deleteBalanceHistoryDataPoint(index: number) {
  const history = userData.balanceHistory;
  if (index < history.v1.length) {
    history.v1.splice(index, 1);
  } else {
    history.v2.splice(index - history.v1.length, 1);
  }
}

function confirmAllDataDelete(ev: Event) {
  showConfirmationOverlay(ev, clearBalanceHistory, {
    message: `你即将清除所有历史财务数据。是否继续？`,
  });
}

function formatValue(number?: number) {
  return number !== undefined ? fixed0(number) : '--';
}

const mmMaterials = ref(userData.settings.financial.mmMaterials);

function onMMMaterialsSubmit() {
  const formatted = (mmMaterials.value ?? '').replaceAll(' ', '').toUpperCase();
  userData.settings.financial.mmMaterials = formatted;
  mmMaterials.value = formatted;
}

const ignoredMaterials = ref(userData.settings.financial.ignoredMaterials);

function onIgnoredMaterialsSubmit() {
  const formatted = (ignoredMaterials.value ?? '').replaceAll(' ', '').toUpperCase();
  userData.settings.financial.ignoredMaterials = formatted;
  ignoredMaterials.value = formatted;
}

const priceTooltips = computed({
  get: () => userData.settings.pricing.materialPriceTooltips === true,
  set: (value: boolean) => {
    userData.settings.pricing.materialPriceTooltips = value;
  },
});
</script>

<template>
  <SectionHeader>权益模式</SectionHeader>
  <Active
    label="权益模式"
    tooltip="在此模式下，权益包括所有资产的市场价值，包括船舶、总部升级和 ARC。
     不建议新手使用，因为初始船舶的价值与初始资源不成比例。
     请注意，即使禁用此模式，你的财务数据历史仍会完整收集，
     因此你可以随时切换到完整权益模式。"
    tooltip-position="bottom">
    <RadioItem v-model="userData.fullEquityMode">完整权益</RadioItem>
  </Active>
  <SectionHeader>价格设置</SectionHeader>
  <Active
    label="物料价格悬浮提示"
    tooltip="鼠标悬浮在库存、MAT 等界面的物料图标上时，显示各交易所的实时买卖价、均价与供需。
      价格取自插件已有的价格缓存，不会发起额外的服务器请求。">
    <RadioItem v-model="priceTooltips">显示物料价格悬浮窗</RadioItem>
  </Active>
  <Active label="MM 材料" tooltip="逗号分隔的做市商材料列表。这些材料的价格将等于 MM 买入价。">
    <TextInput
      v-model="mmMaterials"
      @keyup.enter="onMMMaterialsSubmit"
      @focusout="onMMMaterialsSubmit" />
  </Active>
  <Active label="忽略材料" tooltip="逗号分隔的忽略材料列表。这些材料的价格被视为零。">
    <TextInput
      v-model="ignoredMaterials"
      @keyup.enter="onIgnoredMaterialsSubmit"
      @focusout="onIgnoredMaterialsSubmit" />
  </Active>
  <SectionHeader>已收集的数据点</SectionHeader>
  <form>
    <Commands>
      <PrunButton primary :disabled="!canCollectFinDataPoint()" @click="collectFinDataPoint">
        收集数据点
      </PrunButton>
    </Commands>
  </form>
  <table>
    <thead>
      <tr>
        <th>日期</th>
        <th>权益</th>
        <th>命令</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(balance, i) in sortedData" :key="objectId(balance)">
        <td>{{ hhmm(balance.timestamp) }} {{ ddmmyyyy(balance.timestamp) }}</td>
        <td>{{ formatValue(calcEquity(balance)) }}</td>
        <td>
          <PrunButton dark inline @click="confirmDataPointDelete($event, i)">删除</PrunButton>
        </td>
      </tr>
    </tbody>
  </table>
  <SectionHeader>
    危险区域
    <Tooltip :class="$style.tooltip" tooltip="清除所有历史财务数据" />
  </SectionHeader>
  <form>
    <Commands>
      <PrunButton danger @click="confirmAllDataDelete">清除财务数据</PrunButton>
    </Commands>
  </form>
</template>

<style module>
.tooltip {
  float: revert;
  font-size: 12px;
  margin-top: -4px;
}
</style>
