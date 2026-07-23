<script setup lang="ts">
import PrunLink from '@src/components/PrunLink.vue';
import { isFactionContract } from '@src/infrastructure/prun-api/data/contracts';
import fa from '@src/utils/font-awesome.module.css';
import coloredValue from '@src/infrastructure/prun-ui/css/colored-value.module.css';

defineProps<{ contract: PrunApi.Contract }>();
</script>

<template>
  <PrunLink v-if="isFactionContract(contract)" :command="`FA ${contract.partner.countryCode}`">
    <span :class="[fa.regular, coloredValue.warning]">{{ '\uf005' }}</span>
    {{ contract.partner.name }}
  </PrunLink>
  <PrunLink v-else-if="contract.partner.name" :command="`CO ${contract.partner.code}`">
    {{ contract.partner.name }}
  </PrunLink>
  <PrunLink v-else-if="contract.partner.code" :command="`CO ${contract.partner.code}`" />
  <div
    v-else-if="contract.partner.currency"
    data-tooltip="Refined PrUn 无法获取政府信息。请查看合同详情了解更多。"
    data-tooltip-position="down"
    :class="$style.overrideTooltipStyle">
    星球政府
  </div>
  <div v-else>未知</div>
</template>

<style module>
.overrideTooltipStyle {
  display: block;
  padding: 0;
}
</style>
