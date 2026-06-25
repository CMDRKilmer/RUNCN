<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import Commands from '@src/components/forms/Commands.vue';
import PrunButton from '@src/components/PrunButton.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import { showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import EditPriceLimits from '@src/features/XIT/ACT/actions/cx-buy/EditPriceLimits.vue';
import PriceInfo from '@src/features/XIT/ACT/actions/cx-buy/PriceInfo.vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

const { action, pkg } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

const materialGroups = computed(() => pkg.groups.map(x => x.name!).filter(x => x));
const materialGroup = ref(action.group ?? materialGroups.value[0]);

const exchanges = ['AI1', 'CI1', 'IC1', 'NC1', 'CI2', 'NC2'];
const exchange = ref(action.exchange ?? exchanges[0]);

const priceLimits = ref(getPriceLimits());

function getPriceLimits() {
  const priceLimits = action.priceLimits ?? {};
  return Object.keys(priceLimits).map(x => [x, priceLimits[x]]) as [string, number][];
}

const buyPartial = ref(action.buyPartial ?? false);

const allowUnfilled = ref(action.allowUnfilled ?? false);
const useCXInv = ref(action.useCXInv ?? true);

const priceLimitTickers = computed(() =>
  priceLimits.value.map(([ticker]) => ticker).filter(t => !!t),
);

function onEditPriceLimitsClick(e: Event) {
  showTileOverlay(e, EditPriceLimits, reactive({ priceLimits, exchange: exchange.value }));
}

function validate() {
  return true;
}

function save() {
  action.group = materialGroup.value;
  action.exchange = exchange.value;
  action.priceLimits = {};
  for (let [ticker, price] of priceLimits.value) {
    const material = materialsStore.getByTicker(ticker);
    if (!material || price === 0 || !isFinite(price)) {
      continue;
    }
    action.priceLimits[material.ticker] = price;
  }
  action.buyPartial = buyPartial.value;
  action.allowUnfilled = allowUnfilled.value;
  action.useCXInv = useCXInv.value;
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="材料组">
    <SelectInput v-model="materialGroup" :options="materialGroups" />
  </Active>
  <Active label="交易所">
    <SelectInput v-model="exchange" :options="exchanges" />
  </Active>
  <Commands label="价格限制">
    <PrunButton primary @click="onEditPriceLimitsClick">编辑</PrunButton>
  </Commands>
  <Active label="允许部分购买" tooltip="CX 库存不足时是否仍然执行操作。">
    <RadioItem v-model="buyPartial">允许部分购买</RadioItem>
  </Active>
  <Active label="允许未满足" tooltip="即使 CX 库存不足，仍创建完整的买单。">
    <RadioItem v-model="allowUnfilled">允许未满足</RadioItem>
  </Active>
  <Active label="使用 CX 库存" tooltip="计算需要购买的数量时是否使用 CX 仓库中的库存。">
    <RadioItem v-model="useCXInv">使用 CX 库存</RadioItem>
  </Active>
  <div v-if="priceLimitTickers.length > 0" :class="$style.priceOverview">
    <div :class="$style.priceOverviewHeader">价格概览（基于当前价格限制）</div>
    <PriceInfo
      v-for="ticker in priceLimitTickers"
      :key="ticker"
      :ticker="ticker"
      :exchange="exchange" />
  </div>
</template>

<style module>
.priceOverview {
  margin: 4px 4px 8px;
  padding: 4px 6px;
  border: 1px solid #2b485a;
  background: rgba(0, 0, 0, 0.1);
}

.priceOverviewHeader {
  color: #888;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}
</style>
