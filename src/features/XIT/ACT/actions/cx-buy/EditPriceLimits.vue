<script setup lang="ts">
import { computed } from 'vue';
import { objectId } from '@src/utils/object-id';
import NumberInput from '@src/components/forms/NumberInput.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PriceInfo from '@src/features/XIT/ACT/actions/cx-buy/PriceInfo.vue';

const props = defineProps<{
  priceLimits: [string, number][];
  exchange?: string;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const pairs = computed(() =>
  props.priceLimits.map((pair, i) => {
    const [ticker] = pair;
    return { pair, ticker, index: i };
  }),
);

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
        <PriceInfo v-if="item.ticker" :ticker="item.ticker" :exchange="props.exchange ?? ''" />
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
