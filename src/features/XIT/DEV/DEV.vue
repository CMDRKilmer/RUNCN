<script setup lang="ts">
import { downloadFile } from '@src/utils/dom';
import DebugButton from '@src/features/XIT/DEV/DevButton.vue';
import { userData } from '@src/store/user-data';
import Cookies from 'js-cookie';
import { mergedPrunStyles, prunStyleUpdated } from '@src/infrastructure/prun-ui/prun-css';
import { isRecordingPrunLog, prunLog } from '@src/infrastructure/prun-api/prun-api-listener';
import SectionHeader from '@src/components/SectionHeader.vue';
import { relayUrl } from '@src/infrastructure/prun-api/relay';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';

function logUserData() {
  console.log(userData);
}

const prunDebug = ref(Cookies.get('pu-debug') === 'true');

function switchPrunDebug() {
  Cookies.set('pu-debug', (!prunDebug.value).toString());
  prunDebug.value = !prunDebug.value;
}

function recordPrunLog() {
  isRecordingPrunLog.value = true;
}

function stopRecordingPrunLog() {
  isRecordingPrunLog.value = false;
  downloadFile(prunLog.value, 'prun-log.json', true);
  prunLog.value = [];
}

function downloadCssDefinition() {
  let definition = `export {};\n`;
  definition += `declare global {\n`;
  definition += `  interface PrunCssClasses {\n`;
  for (const key of Object.keys(C).sort()) {
    definition += `    ${key}: {\n`;
    for (const childKey of Object.keys(C[key]).sort()) {
      definition += `      ${childKey}: string;\n`;
    }
    definition += `    };\n`;
  }
  definition += '  }\n';
  definition += '}\n';
  downloadFile(definition, 'prun-css.types.d.ts', false);
}

function downloadPrunStyles() {
  downloadFile(mergedPrunStyles, 'prun.css', false);
  if (import.meta.env.DEV) {
    window.open('https://github.com/refined-prun/prun-css/upload/main');
  }
}
</script>

<template>
  <div :style="{ paddingTop: '4px' }">
    <SectionHeader>警告：修改这些内容可能导致意外行为</SectionHeader>
    <form>
      <Active label="中继">
        <TextInput v-model="relayUrl" />
      </Active>
    </form>
    <DebugButton v-if="!isRecordingPrunLog" @click="recordPrunLog">录制 PrUn 日志</DebugButton>
    <DebugButton v-else @click="stopRecordingPrunLog">停止录制</DebugButton>
    <DebugButton @click="switchPrunDebug"> {{ prunDebug ? '禁用' : '启用' }} pu-debug </DebugButton>
    <DebugButton @click="logUserData">记录用户数据</DebugButton>
    <DebugButton @click="downloadCssDefinition">导出 prun-css.types.d.ts</DebugButton>
    <DebugButton @click="downloadPrunStyles">
      导出 prun.css <span v-if="prunStyleUpdated">(新!)</span>
    </DebugButton>
  </div>
</template>
