<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';

const { action } = defineProps<{
  action: UserData.ActionData;
  pkg: UserData.ActionPackageData;
}>();

// 四大交易所的 CX 仓库。
const exchanges = ['IC1', 'NC1', 'AI1', 'CI1'];
const exchange = ref(action.exchange ?? exchanges[0]);
const ticker = ref(action.ticker ?? '');
const amount = ref(action.amount ?? 0);
const sellMode = ref<'LIMIT' | 'FILL'>(action.sellMode ?? 'LIMIT');
const rank = ref(action.rank ?? 1);

function validate() {
  return ticker.value.trim().length > 0 && (amount.value ?? 0) > 0;
}

function save() {
  action.exchange = exchange.value;
  action.ticker = ticker.value.trim().toUpperCase();
  action.amount = amount.value ?? 0;
  action.sellMode = sellMode.value;
  action.rank = Math.max(1, Math.floor(rank.value ?? 1));
}

defineExpose({ validate, save });
</script>

<template>
  <Active label="交易所">
    <SelectInput v-model="exchange" :options="exchanges" />
  </Active>
  <Active label="物品代码">
    <TextInput v-model="ticker" />
  </Active>
  <Active label="数量">
    <NumberInput v-model="amount" :min="0" />
  </Active>
  <Active label="售卖方式">
    <RadioItem :model-value="sellMode === 'LIMIT'" @update:model-value="() => (sellMode = 'LIMIT')">
      挂单售卖
    </RadioItem>
    <RadioItem :model-value="sellMode === 'FILL'" @update:model-value="() => (sellMode = 'FILL')">
      填单售卖
    </RadioItem>
  </Active>
  <Active label="挂单排名" tooltip="1=卖价第一名（默认），2=第二名，以此类推。填单模式忽略此项。">
    <NumberInput v-model="rank" :min="1" />
  </Active>
</template>
