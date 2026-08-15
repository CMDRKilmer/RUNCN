<script setup lang="ts">
import DaysCell from '@src/features/XIT/BURN/DaysCell.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import PrunButton from '@src/components/PrunButton.vue';
import { PlanetBurn } from '@src/core/burn';
import { getBaseAlias } from '@src/core/base-aliases';
import { countDays } from '@src/features/XIT/BURN/utils';

const { burn } = defineProps<{
  burn: PlanetBurn;
  hasMinimize?: boolean;
  minimized?: boolean;
  onClick: () => void;
}>();

const days = computed(() => countDays(burn.burn));

// Only show generate button for real planets (not the overall summary).
const isRealPlanet = computed(() => burn.naturalId !== '');

// 基地别名（总览行没有 siteId，不显示别名）。
const alias = computed(() => (burn.siteId ? getBaseAlias(burn.siteId) : undefined));

function onGenerateActClick() {
  showBuffer(`XIT BURNGEN ${burn.planetName}`);
}
</script>

<template>
  <tr :class="$style.row">
    <td colspan="4" :class="$style.cell" @click="onClick">
      <span v-if="hasMinimize" :class="$style.minimize">
        {{ minimized ? '+' : '-' }}
      </span>
      <span>{{ burn.planetName }}</span>
      <span v-if="alias" :class="$style.alias">（{{ alias }}）</span>
    </td>
    <DaysCell :days="days" />
    <td>
      <div :class="$style.buttons">
        <PrunButton dark inline @click="showBuffer(`BS ${burn.naturalId}`)">BS</PrunButton>
        <PrunButton dark inline @click="showBuffer(`INV ${burn.storeId.substring(0, 8)}`)">
          INV
        </PrunButton>
        <PrunButton v-if="isRealPlanet" dark inline @click="onGenerateActClick">ACT</PrunButton>
      </div>
    </td>
  </tr>
</template>

<style module>
.row {
  border-bottom: 1px solid #2b485a;
}

.cell {
  font-weight: bold;
  font-size: 12px;
  cursor: pointer;
}

.alias {
  color: #888;
  margin-left: 4px;
}

.minimize {
  display: inline-block;
  width: 26px;
  text-align: center;
}

.buttons {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  column-gap: 0.25rem;
}
</style>
