<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Commands from '@src/components/forms/Commands.vue';
import Active from '@src/components/forms/Active.vue';
import { uploadJson, downloadJson } from '@src/utils/json-file';
import { ddmmyyyy, hhmm } from '@src/utils/format';
import {
  BackupFile,
  mergeUserDataBackups,
  validateBackup,
} from '@src/infrastructure/storage/user-data-finmerge';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const backupA = shallowRef<BackupFile>();
const backupB = shallowRef<BackupFile>();

function uploadBackup(target: 'A' | 'B') {
  uploadJson(json => {
    if (!validateBackup(json)) {
      alert(getI18nValue('RP.SET.FINMERGE.invalid', 'Invalid backup file.'));
      return;
    }
    if (target === 'A') {
      backupA.value = json;
    } else {
      backupB.value = json;
    }
  });
}

const merge = computed(() => {
  if (!backupA.value || !backupB.value) {
    return undefined;
  }
  return mergeUserDataBackups(backupA.value, backupB.value);
});

function formatTimestamp(timestamp: number) {
  return timestamp === 0
    ? getI18nValue('RP.SET.FINMERGE.noData', 'no data')
    : `${ddmmyyyy(timestamp)} ${hhmm(timestamp)}`;
}

function download() {
  if (!merge.value) {
    return;
  }
  downloadJson(merge.value.result, `rp-user-data-finmerge-${Date.now()}.json`);
}

function mismatchText(a: number, b: number) {
  const tmpl = getI18nValue(
    'RP.SET.FINMERGE.skippedMismatch',
    'skipped, tuple length mismatch (${a} vs ${b})',
  );
  return tmpl.replace('${a}', String(a)).replace('${b}', String(b));
}
</script>

<template>
  <SectionHeader>{{
    getI18nValue('RP.SET.FINMERGE.title', 'Merge Financial Backups')
  }}</SectionHeader>
  <form>
    <Commands :label="getI18nValue('RP.SET.FINMERGE.backupA', 'Backup A')">
      <PrunButton primary @click="uploadBackup('A')">{{
        getI18nValue('RP.SET.FINMERGE.upload', 'Upload')
      }}</PrunButton>
    </Commands>
    <Commands :label="getI18nValue('RP.SET.FINMERGE.backupB', 'Backup B')">
      <PrunButton primary @click="uploadBackup('B')">{{
        getI18nValue('RP.SET.FINMERGE.upload', 'Upload')
      }}</PrunButton>
    </Commands>
  </form>
  <template v-if="merge">
    <SectionHeader>{{ getI18nValue('RP.SET.FINMERGE.report', 'Report') }}</SectionHeader>
    <form>
      <Active :label="getI18nValue('RP.SET.FINMERGE.baseBackup', 'Base backup')">{{
        merge.report.base
      }}</Active>
      <Active :label="getI18nValue('RP.SET.FINMERGE.baseLatestDay', 'Base latest day')">{{
        formatTimestamp(merge.report.baseLatest)
      }}</Active>
      <Active :label="getI18nValue('RP.SET.FINMERGE.otherLatestDay', 'Other latest day')">{{
        formatTimestamp(merge.report.otherLatest)
      }}</Active>
      <Active :label="getI18nValue('RP.SET.FINMERGE.daysAddedV1', 'Days added (v1)')">
        {{
          merge.report.v1Mismatch
            ? mismatchText(merge.report.v1Mismatch[0], merge.report.v1Mismatch[1])
            : merge.report.v1DaysAdded
        }}
      </Active>
      <Active :label="getI18nValue('RP.SET.FINMERGE.daysAddedV2', 'Days added (v2)')">
        {{
          merge.report.v2Mismatch
            ? mismatchText(merge.report.v2Mismatch[0], merge.report.v2Mismatch[1])
            : merge.report.v2DaysAdded
        }}
      </Active>
    </form>
    <form>
      <Commands>
        <PrunButton primary @click="download">{{
          getI18nValue('RP.SET.FINMERGE.downloadMerged', 'Download Merged Backup')
        }}</PrunButton>
      </Commands>
    </form>
  </template>
</template>

<style scoped></style>
