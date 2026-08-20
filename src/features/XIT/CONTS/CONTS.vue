<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import ContractRow from '@src/features/XIT/CONTS/ContractRow.vue';
import { isEmpty } from 'ts-extras';
import { compareContracts } from '@src/features/XIT/CONTS/utils';

const filtered = computed(() =>
  contractsStore.all.value!.filter(shouldShowContract).sort(compareContracts),
);

function shouldShowContract(contract: PrunApi.Contract) {
  switch (contract.status) {
    case 'OPEN':
    case 'CLOSED':
    case 'PARTIALLY_FULFILLED':
    case 'DEADLINE_EXCEEDED': {
      return true;
    }
    default: {
      return false;
    }
  }
}
</script>

<template>
  <LoadingSpinner v-if="!contractsStore.fetched" />
  <table v-else>
    <thead>
      <tr>
        <th>合同</th>
        <th>物品</th>
        <th>对方</th>
        <th>自己</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="isEmpty(filtered)">
        <td colspan="4">没有活动合同</td>
      </tr>
      <template v-else>
        <ContractRow v-for="contract in filtered" :key="contract.id" :contract="contract" />
      </template>
    </tbody>
  </table>
</template>
