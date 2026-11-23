<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import Commands from '@src/components/forms/Commands.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import { getResupplyDays } from '@src/core/burn';
import { filterBurnValues } from '@src/features/XIT/BURN/burn-totals';
import { openExchangeBurnAct } from '@src/features/XIT/BURN/exchange-burn-actions';
import { useExchangeBurn } from '@src/features/XIT/BURN/use-exchange-burn';
import { getWarehouseName } from '@src/features/XIT/CART/cart-utils';
import { billTotals } from '@src/features/XIT/FLEET/utils';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { fixed0, fixed2 } from '@src/utils/format';

const parameters = useXitParameters();
const exchange = parameters[1]?.toUpperCase() ?? '';
const source = parameters[2]?.toUpperCase();
const production = ref(source !== 'WF' && source !== 'NONE');
const workforce = ref(source !== 'PROD' && source !== 'NONE');
const days = ref<number | undefined>(getResupplyDays() ?? 10);
const validDays = computed(() => (days.value ?? 0) > 0 && Number.isFinite(days.value));
const warehouseName = computed(() => getWarehouseName(exchange));
const { section, needs, notice } = useExchangeBurn(
  exchange,
  burn => filterBurnValues(burn, production.value, workforce.value),
  () => days.value,
);

const materialBill = computed(() =>
  Object.entries(needs.value ?? {}).sort(([a], [b]) => a.localeCompare(b)),
);
const totals = computed(() => billTotals(needs.value ?? {}));
const canGenerate = computed(() => validDays.value && materialBill.value.length > 0);
const showPreview = ref(false);
const packageName = computed(() => `CX ${exchange} Resupply ${days.value ?? 0}d`);

function generate() {
  if (canGenerate.value && needs.value !== undefined) {
    openExchangeBurnAct(exchange, needs.value, packageName.value);
  }
}
</script>

<template>
  <div :class="C.DraftConditionEditor.form">
    <SectionHeader>生成 ACT 补库包</SectionHeader>
    <p v-if="!section">请输入有效的交易所代码，例如 XIT BURNGEN CX IC1。</p>
    <template v-else>
      <form @submit.prevent>
        <Active label="交易所">{{ exchange }}</Active>
        <Active label="补充天数" :error="!validDays">
          <NumberInput v-model="days" />
        </Active>
        <Active label="消耗品" tooltip="包含劳动力消耗品。">
          <RadioItem v-model="workforce">消耗品</RadioItem>
        </Active>
        <Active label="生产原料" tooltip="包含生产线所需的输入原料。">
          <RadioItem v-model="production">生产原料</RadioItem>
        </Active>
        <Active label="仓库" tooltip="从补给量中扣除该仓库的现有库存。">
          {{ warehouseName }}
        </Active>
        <Active label="包名称">{{ packageName }}</Active>
        <Commands>
          <PrunButton primary :disabled="!canGenerate" @click="generate">生成</PrunButton>
          <PrunButton primary :disabled="!canGenerate" @click="showPreview = !showPreview">
            {{ showPreview ? '隐藏预览' : '预览' }}
          </PrunButton>
        </Commands>
      </form>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-else-if="validDays && needs === undefined" role="status">正在读取 CX 仓库库存。</p>
      <p v-else-if="validDays && !canGenerate" role="status">当前补充天数下无采购缺口。</p>
      <template v-if="showPreview && canGenerate">
        <SectionHeader>预览</SectionHeader>
        <Active label="总体积">{{ fixed2(totals.volume) }} m³</Active>
        <Active label="总重量">{{ fixed2(totals.weight) }} t</Active>
        <table>
          <thead>
            <tr>
              <th>物料</th>
              <th>采购量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[ticker, amount] in materialBill" :key="ticker">
              <td>{{ ticker }}</td>
              <td>{{ fixed0(amount) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </template>
  </div>
</template>
