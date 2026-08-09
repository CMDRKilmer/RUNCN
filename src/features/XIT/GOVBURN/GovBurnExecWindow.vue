<script setup lang="ts">
import ExecuteActionPackage from '@src/features/XIT/ACT/ExecuteActionPackage.vue';
import { stagedGovBurn } from '@src/features/XIT/GOVBURN/staged';
import { useMinBufferHeight } from '@src/hooks/use-min-buffer-height';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

useMinBufferHeight();
</script>

<template>
  <div v-if="!stagedGovBurn">{{
    getI18nValue(
      'RP.GOVBURN.exec.nothingStaged',
      'Nothing staged. Open XIT GOVBURNACT and press EXECUTE.',
    )
  }}</div>
  <ExecuteActionPackage v-else :pkg="stagedGovBurn.pkg" />
</template>
