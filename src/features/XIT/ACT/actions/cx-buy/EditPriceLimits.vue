<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { objectId } from '@src/utils/object-id';
import NumberInput from '@src/components/forms/NumberInput.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PriceInfo from '@src/features/XIT/ACT/actions/cx-buy/PriceInfo.vue';

const props = defineProps<{
  priceLimits: { value: [string, number][] };
  exchange?: string;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

// 本地响应式状态副本，避免直接修改 props
const localPriceLimits = ref<[string, number][]>([...props.priceLimits.value]);

// 监听外部 priceLimits 变化，同步到本地状态
watch(
  () => props.priceLimits.value,
  newVal => {
    const newPairs = [...newVal];
    const current = localPriceLimits.value;
    if (
      newPairs.length === current.length &&
      newPairs.every((pair, i) => pair[0] === current[i][0] && pair[1] === current[i][1])
    ) {
      return;
    }
    localPriceLimits.value = newPairs;
  },
  { deep: true },
);

const pairs = computed(() =>
  localPriceLimits.value.map((pair, i) => {
    const [ticker] = pair;
    return { pair, ticker, index: i };
  }),
);

function notifyChange() {
  props.priceLimits.value = [...localPriceLimits.value];
}

function onAddClick() {
  localPriceLimits.value.push(['', 0]);
  notifyChange();
}

function onTickerChange(index: number, value: string | undefined) {
  localPriceLimits.value[index] = [value ?? '', localPriceLimits.value[index][1]];
  notifyChange();
}

function onPriceChange(index: number, value: number | undefined) {
  localPriceLimits.value[index] = [localPriceLimits.value[index][0], value ?? 0];
  notifyChange();
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>编辑价格限制</SectionHeader>
    <form>
      <template v-for="item in pairs" :key="objectId(item.pair)">
        <Active :label="`材料代码 #${item.index + 1}`">
          <TextInput
            :model-value="item.pair[0]"
            @update:model-value="val => onTickerChange(item.index, val)" />
        </Active>
        <Active :label="`价格限制 #${item.index + 1}`">
          <NumberInput
            :model-value="item.pair[1]"
            @update:model-value="val => onPriceChange(item.index, val)" />
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
