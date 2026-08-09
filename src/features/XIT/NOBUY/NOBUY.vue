<script setup lang="ts">
import { userData } from '@src/store/user-data';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import Passive from '@src/components/forms/Passive.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import Commands from '@src/components/forms/Commands.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const input = ref('');
const inputError = ref(false);

function add() {
  const tickers = input.value
    .split(',')
    .map(x => materialsStore.getByTicker(x.trim())?.ticker)
    .filter(x => x !== undefined);

  if (tickers.length === 0) {
    inputError.value = true;
    return;
  }

  inputError.value = false;
  for (const ticker of tickers) {
    if (!userData.settings.noBuy.includes(ticker)) {
      userData.settings.noBuy.push(ticker);
    }
  }
  input.value = '';
}

function remove(ticker: string) {
  const i = userData.settings.noBuy.indexOf(ticker);
  if (i !== -1) {
    userData.settings.noBuy.splice(i, 1);
  }
}

function onInputKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter') {
    add();
  }
}
</script>

<template>
  <SectionHeader>{{ getI18nValue('RP.NOBUY.title', 'No-Buy List') }}</SectionHeader>
  <Passive
    v-if="userData.settings.noBuy.length === 0"
    :label="getI18nValue('RP.NOBUY.title', 'Materials')">
    {{ getI18nValue('RP.common.none', 'None') }}
  </Passive>
  <Passive v-for="ticker in userData.settings.noBuy" :key="ticker" :label="ticker">
    <PrunButton danger @click="remove(ticker)">x</PrunButton>
  </Passive>
  <SectionHeader>{{ getI18nValue('RP.NOBUY.add', 'Add Materials') }}</SectionHeader>
  <form>
    <Active
      :label="getI18nValue('RP.common.search', 'Tickers')"
      :tooltip="
        getI18nValue('RP.NOBUY.tooltip', 'One or more material tickers separated by commas.')
      "
      :error="inputError">
      <TextInput v-model="input" @keydown="onInputKeydown" />
    </Active>
    <Commands>
      <PrunButton primary @click="add">{{ getI18nValue('RP.common.add', 'ADD') }}</PrunButton>
    </Commands>
  </form>
</template>
