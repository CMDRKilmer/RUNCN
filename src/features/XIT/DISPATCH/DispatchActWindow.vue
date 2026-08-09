<script setup lang="ts">
import ExecuteActionPackage from '@src/features/XIT/ACT/ExecuteActionPackage.vue';
import { stagedDispatch } from '@src/features/XIT/DISPATCH/staged';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';
</script>

<template>
  <div v-if="!stagedDispatch">{{
    getI18nValue(
      'RP.DISPATCH.nothingStaged',
      'Nothing staged. Open XIT DISPATCH and press EXECUTE.',
    )
  }}</div>
  <ExecuteActionPackage v-else :pkg="stagedDispatch.pkg" />
</template>
