<script setup lang="ts">
import { computed } from 'vue';
import { objectId } from '@src/utils/object-id';
import NumberInput from '@src/components/forms/NumberInput.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import { cxStore } from '@src/infrastructure/fio/cx';

const props = defineProps<{
  priceLimits: [string, number][];
  exchange?: string;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const pairs = computed(() =>
  props.priceLimits.map((pair, i) => {
    const [ticker] = pair;
    const info = getPriceInfo(ticker);
    return { pair, info, index: i };
  }),
);

function getPriceInfo(ticker: string) {
  if (!ticker || !props.exchange || !cxStore.fetched) {
    return undefined;
  }
  return cxStore.prices.get(props.exchange)?.get(ticker);
}

function onAddClick() {
  props.priceLimits.push(['', 0]);
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>编辑价格限制</SectionHeader>
    <form>
      <template v-for="item in pairs" :key="objectId(item.pair)">
        <Active :label="`材料代码 #${item.index + 1}`">
          <TextInput v-model="item.pair[0]" />
        </Active>
        <Active :label="`价格限制 #${item.index + 1}`">
          <NumberInput v-model="item.pair[1]" />
        </Active>
        <div v-if="item.info" :class="$style.avgPrice">
          7日均价: {{ item.info.VWAP7D ?? '-' }} | 30日均价: {{ item.info.VWAP30D ?? '-' }}
        </div>
      </template>
      <Commands>
        <PrunButton primary @click="onAddClick">添加</PrunButton>
      </Commands>
      <Commands>
        <PrunButton primary @click="emit('close')">关闭</PrunButton>
      </Commands>
    </form>
  </div>
</template>

<style module>
.avgPrice {
  color: #888;
  font-size: 0.85em;
  margin: -4px 4px 6px;
}
</style>
