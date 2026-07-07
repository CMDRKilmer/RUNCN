<script setup lang="ts">
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import Tabs, { Tab } from '@src/components/Tabs.vue';
import GAME from '@src/features/XIT/SET/GAME.vue';
import FEAT from '@src/features/XIT/SET/FEAT.vue';
import FIN from '@src/features/XIT/SET/FIN.vue';
import BFR from '@src/features/XIT/SET/BFR.vue';
import TRANSLATE from '@src/features/XIT/SET/TRANSLATE.vue';

const tabs: Tab[] = [
  {
    id: 'GAME',
    label: '游戏设置',
    component: GAME,
  },
  {
    id: 'FEAT',
    label: '功能',
    component: FEAT,
  },
  {
    id: 'FIN',
    label: '财务',
    component: FIN,
  },
  {
    id: 'BFR',
    label: '缓冲区',
    component: BFR,
  },
  {
    id: 'TRANSLATE',
    label: '翻译',
    component: TRANSLATE,
  },
];

const parameters = useXitParameters();
const parameter = parameters[0];

const activeTab = shallowRef(tabs.find(x => x.id === parameter?.toUpperCase()) ?? tabs[0]);
</script>

<template>
  <Tabs v-model="activeTab" :tabs="tabs" />
</template>
