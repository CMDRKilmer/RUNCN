<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Commands from '@src/components/forms/Commands.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import { showConfirmationOverlay, showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import removeArrayElement from '@src/utils/remove-array-element';
import { createId } from '@src/store/create-id';
import { userData } from '@src/store/user-data';
import { lowFuelShips } from '@src/features/basic/auto-refuel';
import { queueTriggerRun } from '@src/features/XIT/ACT/trigger-queue';
import EditTrigger from '@src/features/XIT/TRIGGER/EditTrigger.vue';
import { triggerEngine } from '@src/features/basic/automation-triggers/trigger-engine';
import { isChainTrigger } from '@src/features/XIT/FLEET/chain-sync';

const eventLabels: Record<UserData.TriggerEventType, string> = {
  FLIGHT_ENDED: '飞船到港',
  SUPPLIES_LOW: '物资告急',
  PRODUCTION_FINISHED: '生产完成',
  BUILDING_CONDITION: '建筑状况',
  INTERVAL: '定时',
};

// Notification 是浏览器全局，Vue 模板无法直接访问 globalThis；
// 通过 computed 暴露，避免模板读取 undefined 导致渲染抛错。
const notificationPermission = computed(() => Notification?.permission ?? 'default');

function describeEvent(event: UserData.TriggerEventData) {
  switch (event.type) {
    case 'FLIGHT_ENDED': {
      const arrival = event.ship ? `${event.ship} 到港` : '飞船到港';
      return event.planet ? `${arrival}（${event.planet}）` : arrival;
    }
    case 'SUPPLIES_LOW':
      return event.planet ? `${event.planet} 物资告急` : '任意基地物资告急';
    case 'PRODUCTION_FINISHED':
      return event.planet ? `${event.planet} 生产完成` : '任意基地生产完成';
    case 'BUILDING_CONDITION':
      return `${event.planet} 建筑低于 ${event.belowPct}%`;
    case 'INTERVAL':
      return '定时触发';
  }
}

function formatTime(timestamp: number | undefined) {
  return timestamp !== undefined ? new Date(timestamp).toLocaleString() : '--';
}

function onAddClick(e: Event) {
  const trigger: UserData.TriggerData = {
    id: createId(),
    name: '',
    enabled: true,
    event: { type: 'INTERVAL' },
    packageName: userData.actionPackages[0]?.global.name ?? '',
    mode: 'AUTO',
    cooldownMin: 60,
    createdAt: Date.now(),
  };
  showTileOverlay(e, EditTrigger, {
    add: true,
    trigger,
    onSave: () => {
      userData.triggers.push(trigger);
      triggerEngine.start();
    },
  });
}

function onEditClick(e: Event, trigger: UserData.TriggerData) {
  showTileOverlay(e, EditTrigger, { trigger });
}

function onDeleteClick(e: Event, trigger: UserData.TriggerData) {
  showConfirmationOverlay(e, () => removeArrayElement(userData.triggers, trigger), {
    message: `确定要删除触发器 "${trigger.name || '--'}" 吗？`,
    confirmLabel: '删除',
  });
}

// 环线自动 vs 手动自定义触发器：分页展示。
// 环线自动 = FLIGHT_ENDED 且操作包为环线命名约定（isChainTrigger）。
const currentTab = ref<'auto' | 'custom'>('auto');
const autoTriggers = computed(() => userData.triggers.filter(isChainTrigger));
const customTriggers = computed(() => userData.triggers.filter(t => !isChainTrigger(t)));
const currentTriggers = computed(() =>
  currentTab.value === 'auto' ? autoTriggers.value : customTriggers.value,
);

// 删除全部：仅删除环线自动触发器（环线重跑可重新生成），
// 手动创建的自定义触发器不受影响。
function onDeleteAllClick(e: Event) {
  showConfirmationOverlay(
    e,
    () => {
      for (let i = userData.triggers.length - 1; i >= 0; i--) {
        if (isChainTrigger(userData.triggers[i]!)) {
          userData.triggers.splice(i, 1);
        }
      }
      triggerEngine.start();
    },
    {
      message: `确定要删除全部环线自动触发器（${autoTriggers.value.length} 条）吗？自定义触发器不受影响。`,
      confirmLabel: '删除全部',
    },
  );
}

// MANUAL 模式：点击执行按钮，直接把操作包入队并打开 XIT ACT 窗口运行。
// 与 trigger-engine 的 execute() 同一路径（队列 + showBuffer）。
function onManualExecute(trigger: UserData.TriggerData) {
  queueTriggerRun({ triggerId: trigger.id, packageName: trigger.packageName });
  showBuffer(`XIT ACT_${trigger.packageName.replace(' ', '_')}`);
}

function modeLabel(trigger: UserData.TriggerData): string {
  switch (trigger.mode) {
    case 'AUTO':
      return 'AUTO';
    case 'CONFIRM':
      return 'CONFIRM';
    case 'MANUAL':
      return '手动';
    default:
      return trigger.mode;
  }
}

async function onRequestNotificationClick() {
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function onOpenNxClick() {
  showBuffer('XIT NX');
}
</script>

<template>
  <SectionHeader>全局设置</SectionHeader>
  <div :class="$style.globalSettings">
    <div :class="$style.modeSwitch">
      <span :class="$style.modeLabel">执行模式</span>
      <RadioItem
        :model-value="userData.settings.triggers.autoEnabled"
        horizontal
        @update:model-value="
          v => {
            if (v) userData.settings.triggers.autoEnabled = true;
          }
        ">
        自动模式
      </RadioItem>
      <RadioItem
        :model-value="!userData.settings.triggers.autoEnabled"
        horizontal
        @update:model-value="
          v => {
            if (v) userData.settings.triggers.autoEnabled = false;
          }
        ">
        手动模式
      </RadioItem>
    </div>
    <p v-if="userData.settings.triggers.autoEnabled" :class="$style.warning">
      注意：自动模式下，AUTO
      触发器触发后无需确认即向服务器提交操作。频繁/无人值守的自动化操作可能违反游戏服务条款，请自行评估风险。
    </p>
    <p v-else :class="$style.hint">手动模式下，AUTO 触发器不会直接执行，需在列表内手动触发。</p>
    <p :class="$style.notification">
      桌面通知（CONFIRM 模式触发时提醒）：
      <span v-if="notificationPermission === 'granted'" :class="$style.ok">已授权</span>
      <span v-else>
        {{ notificationPermission === 'denied' ? '已被浏览器拒绝' : '未授权' }}
        <PrunButton
          v-if="notificationPermission === 'default'"
          dark
          inline
          @click="onRequestNotificationClick">
          授权
        </PrunButton>
      </span>
    </p>
  </div>
  <SectionHeader>内置自动化</SectionHeader>
  <div :class="$style.builtin">
    <div :class="$style.builtinRow">
      <RadioItem v-model="userData.settings.refuel.enabled">自动加油</RadioItem>
      <span :class="$style.builtinStatus">
        停靠且燃料低于 95% 时静默加油
        <template v-if="userData.settings.refuel.enabled">
          · 当前低油 {{ lowFuelShips.length }} 艘
        </template>
      </span>
    </div>
    <div :class="$style.builtinRow">
      <RadioItem v-model="userData.settings.nx.enabled">NX 自动补油</RadioItem>
      <span :class="$style.builtinStatus">实时监听四大空间站仓库油量，低于目标自动购买</span>
      <PrunButton dark inline @click="onOpenNxClick">设置</PrunButton>
    </div>
    <p :class="$style.builtinHint">
      内置自动化是持续策略，随游戏数据实时生效；触发器按事件/条件触发后执行操作包。
    </p>
  </div>
  <SectionHeader>触发器</SectionHeader>
  <div :class="$style.tabs">
    <RadioItem
      :model-value="currentTab === 'auto'"
      horizontal
      @update:model-value="
        v => {
          if (v) currentTab = 'auto';
        }
      ">
      环线自动（{{ autoTriggers.length }}）
    </RadioItem>
    <RadioItem
      :model-value="currentTab === 'custom'"
      horizontal
      @update:model-value="
        v => {
          if (v) currentTab = 'custom';
        }
      ">
      自定义（{{ customTriggers.length }}）
    </RadioItem>
  </div>
  <table>
    <thead>
      <tr>
        <th>名称</th>
        <th>事件</th>
        <th>操作包</th>
        <th>模式</th>
        <th>操作</th>
        <th>冷却</th>
        <th>上次触发</th>
        <th>次数</th>
        <th />
      </tr>
    </thead>
    <tbody v-if="currentTriggers.length === 0">
      <tr>
        <td colspan="8" :class="$style.emptyRow">
          {{ currentTab === 'auto' ? '还没有环线自动触发器。' : '还没有自定义触发器。' }}
        </td>
      </tr>
    </tbody>
    <tbody v-else>
      <tr v-for="trigger in currentTriggers" :key="trigger.id">
        <td>{{ trigger.name || '--' }}</td>
        <td>{{ describeEvent(trigger.event) }}</td>
        <td>
          <span
            v-if="!userData.actionPackages.some(x => x.global.name === trigger.packageName)"
            :class="$style.warning">
            缺失
          </span>
          <span v-else>{{ trigger.packageName }}</span>
        </td>
        <td>
          <span v-if="trigger.mode === 'AUTO' && !userData.settings.triggers.autoEnabled">
            AUTO（禁用）
          </span>
          <span v-else>{{ modeLabel(trigger) }}</span>
        </td>
        <td>
          <PrunButton dark inline @click="onManualExecute(trigger)">执行</PrunButton>
        </td>
        <td>{{
          trigger.event.type === 'INTERVAL'
            ? `${trigger.cooldownMin} 分钟周期`
            : `${trigger.cooldownMin} 分钟`
        }}</td>
        <td>{{ formatTime(trigger.lastRun) }}</td>
        <td>{{ trigger.runCount ?? 0 }}</td>
        <td>
          <RadioItem v-model="trigger.enabled">启用</RadioItem>
          <PrunButton dark inline @click="onEditClick($event, trigger)">编辑</PrunButton>
          <PrunButton dark inline @click="onDeleteClick($event, trigger)">删除</PrunButton>
        </td>
      </tr>
    </tbody>
  </table>
  <form :class="$style.sectionCommands">
    <Commands>
      <PrunButton v-if="currentTab === 'custom'" primary @click="onAddClick">添加</PrunButton>
      <PrunButton
        v-if="currentTab === 'auto' && autoTriggers.length > 0"
        dark
        @click="onDeleteAllClick">
        删除全部
      </PrunButton>
    </Commands>
  </form>
  <p :class="$style.hint">
    事件类型：{{
      Object.values(eventLabels).join(' / ')
    }}。告警类事件即时触发；条件类事件每分钟评估，持续满足且冷却到期即触发。
  </p>
</template>

<style module>
.globalSettings {
  margin: 4px 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.warning {
  color: #e06c75;
  margin: 0;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.modeSwitch {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.modeLabel {
  color: #8a9aa8;
}

.notification {
  margin: 0;
}

.builtin {
  margin: 4px 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.builtinRow {
  display: flex;
  align-items: center;
  gap: 10px;
}

.builtinStatus {
  font-size: 0.85em;
  color: #888;
}

.builtinHint {
  margin: 2px 0 0;
  font-size: 0.8em;
  color: #666;
}

.ok {
  color: #98c379;
}

.emptyRow {
  text-align: center;
}

.autoBadge {
  font-size: 0.8em;
  color: #56b6c2;
  font-family: monospace;
  letter-spacing: 0.5px;
}

.sectionCommands {
  margin-top: 0.75rem;
}

.hint {
  margin: 8px 6px;
  color: #888;
}
</style>
