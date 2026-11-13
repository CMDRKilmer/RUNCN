<script setup lang="ts">
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { fixed0 } from '@src/utils/format';
import { isFiniteOrder } from '@src/core/orders';

const { ticker } = defineProps<{ ticker?: string }>();

const orderBook = computed(() => cxobStore.getByTicker(ticker));

const demand = computed(() => sumOrders(orderBook.value?.buyingOrders ?? []));
const supply = computed(() => sumOrders(orderBook.value?.sellingOrders ?? []));

function sumOrders(orders: PrunApi.CXBrokerOrder[]) {
  let sum = 0;
  for (const order of orders) {
    if (!isFiniteOrder(order)) {
      break;
    }
    sum += order.amount;
  }
  return sum;
}
</script>

<template>
  <div v-if="orderBook">
    <div :class="$style.demand" data-tooltip="预处理前需求" data-tooltip-position="right">
      {{ fixed0(demand) }}
    </div>
    <div :class="$style.supply" data-tooltip="预处理前供给" data-tooltip-position="left">
      {{ fixed0(supply) }}
    </div>
  </div>
</template>

<style module>
.demand {
  position: absolute;
  top: 0;
  left: 0;
  padding: 2px 8px 0 8px;
  color: #5cb85c;
}

.supply {
  position: absolute;
  top: 0;
  right: 0;
  padding: 2px 8px 0 8px;
  color: var(--rp-skin-danger, #9c3b3b);
}
</style>
