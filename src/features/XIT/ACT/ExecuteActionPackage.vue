<script setup lang="ts">
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Header from '@src/components/Header.vue';
import { ActionRunner } from '@src/features/XIT/ACT/runner/action-runner';
import { useTile } from '@src/hooks/use-tile';
import { Logger, LogTag } from '@src/features/XIT/ACT/runner/logger';
import LogWindow from '@src/features/XIT/ACT/LogWindow.vue';
import ConfigWindow from '@src/features/XIT/ACT/ConfigureWindow.vue';
import { ActionPackageConfig } from '@src/features/XIT/ACT/shared-types';
import { act } from '@src/features/XIT/ACT/act-registry';
import { userData } from '@src/store/user-data';
import { consumeTriggerRun, hasPendingTriggerRun } from '@src/features/XIT/ACT/trigger-queue';

const { pkg } = defineProps<{ pkg: UserData.ActionPackageData }>();

// 模块级自动标志：ACT 窗口从独立小窗打开时 TileAllocator 会触发缓冲区拆分，
// 组件卸载重挂载后组件内 ref 会被重置（导致自动运行退化为手动等待），
// 提升到模块级让自动标志跨重挂载保持。
const autoAct = ref(false);

const tile = useTile();
let goingToSplit = ref(false);

const config = ref({
  globalOptions: { skipMissingMaterials: false },
  materialGroups: {},
  actions: {},
} as ActionPackageConfig);

const log = ref([] as { tag: LogTag; message: string }[]);
const logScrolling = ref(true);
const isPreviewing = ref(false);
const isRunning = ref(false);
const status = ref(undefined as string | undefined);
const actReady = ref(false);

watch(config, clearLog, { deep: true });

watchEffect(() => {
  for (const name of pkg.groups.map(x => x.name!)) {
    if (config.value.materialGroups[name] === undefined) {
      config.value.materialGroups[name] = {};
    }
  }
  for (const name of pkg.actions.map(x => x.name!)) {
    if (config.value.actions[name] === undefined) {
      config.value.actions[name] = {};
    }
  }
});

const needsConfigure = computed(() => {
  for (const action of pkg.actions) {
    const info = act.getActionInfo(action.type);
    if (info && info.needsConfigure?.(action)) {
      return true;
    }
  }
  for (const group of pkg.groups) {
    const info = act.getMaterialGroupInfo(group.type);
    if (info && info.needsConfigure?.(group)) {
      return true;
    }
  }
  return false;
});

const isValidConfig = computed(() => {
  for (const action of pkg.actions) {
    const info = act.getActionInfo(action.type);
    let actionConfig = config.value.actions[action.name!] ?? {};
    const isValid = info?.isValidConfig?.(action, actionConfig) ?? true;
    if (!isValid) {
      return false;
    }
  }
  for (const group of pkg.groups) {
    const info = act.getMaterialGroupInfo(group.type);
    let groupConfig = config.value.materialGroups[group.name!] ?? {};
    const isValid = info?.isValidConfig?.(group, groupConfig) ?? true;
    if (!isValid) {
      return false;
    }
  }
  return true;
});

const showConfigure = ref(true);

const shouldShowConfigure = computed(() => {
  return needsConfigure.value && (!isValidConfig.value || showConfigure.value);
});

const runner = new ActionRunner({
  tile,
  log: new Logger(logMessage),
  onBufferSplit: () => (goingToSplit.value = true),
  onStart: () => (isRunning.value = true),
  onEnd: (success: boolean) => {
    isRunning.value = false;
    status.value = undefined;
    autoAct.value = false;
    // 一次性操作包（BURNGEN 生成）执行成功后自动删除。
    if (success && pkg.autoDelete) {
      const idx = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
      if (idx >= 0) {
        userData.actionPackages.splice(idx, 1);
      }
      // 同步删除指向该操作包的一次性触发器（FLEET 到港卸货）。
      for (let i = userData.triggers.length - 1; i >= 0; i--) {
        const trigger = userData.triggers[i];
        if (trigger.autoDelete && trigger.packageName === pkg.global.name) {
          userData.triggers.splice(i, 1);
        }
      }
    }
  },
  onStatusChanged: (title, keepReady) => {
    status.value = title;
    if (!keepReady) {
      actReady.value = false;
    }
  },
  onActReady: () => {
    actReady.value = true;
  },
  isAutoAct: () => autoAct.value,
});

// 触发器队列监视：队列中出现本操作包的待执行项时自动开始（预览通过后执行）。
// immediate 覆盖触发器新开窗口的场景；窗口已开时由队列变化触发。
watch(
  () => hasPendingTriggerRun(pkg.global.name),
  has => {
    if (has) {
      consumeTriggerRun(pkg.global.name);
      void onAutoClick();
    }
  },
  { immediate: true },
);

function onConfigureApplyClick() {
  showConfigure.value = false;
}

function onConfigureClick() {
  showConfigure.value = true;
}

async function onPreviewClick() {
  logScrolling.value = false;
  clearLog();
  isPreviewing.value = true;
  await runner.preview(pkg, config.value);
  isPreviewing.value = false;
  status.value = undefined;
}

function onExecuteClick() {
  logScrolling.value = true;
  clearLog();
  actReady.value = false;
  runner.execute(pkg, config.value);
}

function onCancelClick() {
  actReady.value = false;
  autoAct.value = false;
  runner.cancel();
}

function onActClick() {
  actReady.value = false;
  runner.act();
}

// 运行中切换自动模式：开启后从当前步骤起自动继续；若正停在手动等待处立即继续
function onToggleAutoMidRun() {
  autoAct.value = !autoAct.value;
  if (autoAct.value && actReady.value) {
    onActClick();
  }
}

// 触发式自动执行：点击后先预览（生成步骤+汇总），预览通过后自动执行
async function onAutoClick() {
  if (isRunning.value) {
    return;
  }
  autoAct.value = true;
  logScrolling.value = false;
  clearLog();
  isPreviewing.value = true;
  const ok = await runner.preview(pkg, config.value);
  isPreviewing.value = false;
  if (!ok) {
    autoAct.value = false;
    status.value = undefined;
    return;
  }
  logScrolling.value = true;
  actReady.value = false;
  runner.execute(pkg, config.value);
}

function onSkipClick() {
  actReady.value = false;
  runner.skip();
}

function logMessage(tag: LogTag, message: string) {
  return log.value.push({ tag, message });
}

function clearLog() {
  log.value.length = 0;
}
</script>

<template>
  <div v-if="goingToSplit" />
  <div v-else :class="$style.root">
    <Header :class="$style.header">{{ pkg.global.name }}</Header>
    <ConfigWindow
      v-if="shouldShowConfigure"
      :pkg="pkg"
      :config="config"
      :class="$style.mainWindow" />
    <LogWindow v-else :messages="log" :scrolling="logScrolling" :class="$style.mainWindow" />
    <div :class="$style.status">
      <span>状态：</span>
      <span v-if="status">{{ status }}</span>
      <span v-else-if="shouldShowConfigure">请配置材料组参数 ↑</span>
      <span v-else>按执行开始</span>
    </div>
    <ActionBar :class="$style.actionBar">
      <template v-if="shouldShowConfigure">
        <PrunButton primary :disabled="!isValidConfig" @click="onConfigureApplyClick">
          应用
        </PrunButton>
      </template>
      <template v-else-if="isPreviewing">
        <div :class="$style.actionGroup">
          <PrunButton v-if="needsConfigure" primary @click="onConfigureClick">配置</PrunButton>
          <PrunButton disabled>预览</PrunButton>
          <PrunButton disabled>执行</PrunButton>
        </div>
      </template>
      <template v-else-if="!isRunning">
        <div :class="$style.actionGroup">
          <PrunButton v-if="needsConfigure" primary @click="onConfigureClick">配置</PrunButton>
          <PrunButton primary @click="onPreviewClick">预览</PrunButton>
          <PrunButton primary :class="$style.executeButton" @click="onExecuteClick">
            执行
          </PrunButton>
          <PrunButton danger :disabled="!isValidConfig" @click="onAutoClick">自动</PrunButton>
          <label :class="$style.skipCheckbox">
            <input
              v-model="config.globalOptions!.skipMissingMaterials"
              type="checkbox" />跳过不足材料
          </label>
        </div>
      </template>
      <template v-else>
        <div :class="$style.actionGroup">
          <PrunButton v-if="needsConfigure" primary disabled>配置</PrunButton>
          <PrunButton primary disabled>预览</PrunButton>
          <PrunButton
            danger
            :disabled="!actReady"
            :class="$style.executeButton"
            @click="onCancelClick">
            取消
          </PrunButton>
          <PrunButton primary :disabled="!actReady" @click="onActClick">执行步骤</PrunButton>
          <PrunButton neutral :disabled="!actReady" @click="onSkipClick">跳过</PrunButton>
          <PrunButton danger @click="onToggleAutoMidRun">
            {{ autoAct ? '🟢 自动' : '自动' }}
          </PrunButton>
          <label :class="$style.skipCheckbox">
            <input
              v-model="config.globalOptions!.skipMissingMaterials"
              type="checkbox" />跳过不足材料
          </label>
        </div>
      </template>
    </ActionBar>
  </div>
</template>

<style module>
.root {
  height: 100%;
  display: flex;
  flex-direction: column;
  user-select: none;
}

.mainWindow {
  flex-grow: 1;
}

.header {
  margin-left: 4px;
}

.status {
  margin-left: 5px;
  margin-top: 5px;
}

.actionBar {
  margin-left: 2px;
  justify-content: flex-start;
  user-select: none;
}

.actionGroup {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.skipCheckbox {
  display: flex;
  align-items: center;
  margin-right: 5px;
  margin-left: 5px;
  font-size: 11px;
  cursor: pointer;
  color: #ccc;
}

.skipCheckbox input {
  margin-right: 4px;
}

/* 使取消和执行按钮宽度相同，保持布局稳定。 */
.executeButton {
  width: 68px;
}
</style>
