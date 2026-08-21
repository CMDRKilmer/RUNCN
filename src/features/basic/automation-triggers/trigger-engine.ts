import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import { userData } from '@src/store/user-data';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { queueTriggerRun } from '@src/features/XIT/ACT/trigger-queue';
import { alertSources, evaluateTriggerCondition, isAlertSource } from './event-sources';
import { watchUntil } from '@src/utils/watch';
import { watch } from 'vue';

// 条件源评估周期（后台标签页浏览器最低也约 1 分钟，电平语义可容忍）。
const CONDITION_EVALUATE_INTERVAL = 60_000;
// 冷却下限：防止配置过小导致高频触发。
const MIN_COOLDOWN_MS = 15 * 60_000;

class TriggerEngine {
  private knownAlertIds = new Set<string>();
  private started = false;

  start() {
    if (this.started) {
      return;
    }
    this.started = true;

    // 等告警数据加载完成后建立基线，避免把历史告警当成新事件。
    void watchUntil(() => alertsStore.fetched.value).then(() => {
      for (const alert of alertsStore.all.value ?? []) {
        this.knownAlertIds.add(alert.id);
      }
      watch(
        () => alertsStore.all.value,
        alerts => this.onAlerts(alerts),
      );
    });

    window.setInterval(() => this.evaluateConditions(), CONDITION_EVALUATE_INTERVAL);
  }

  private onAlerts(alerts: PrunApi.Alert[] | undefined) {
    if (!alerts) {
      return;
    }
    for (const alert of alerts) {
      if (this.knownAlertIds.has(alert.id)) {
        continue;
      }
      this.knownAlertIds.add(alert.id);
      this.onNewAlert(alert);
    }
  }

  private onNewAlert(alert: PrunApi.Alert) {
    for (const trigger of userData.triggers) {
      if (!trigger.enabled) {
        continue;
      }
      const source = alertSources[trigger.event.type];
      if (!source || !source.alertTypes.includes(alert.type)) {
        continue;
      }
      if (!source.matches(trigger.event, alert)) {
        continue;
      }
      if (!this.passesCooldown(trigger)) {
        continue;
      }
      this.fire(trigger, source.describe(alert));
    }
  }

  private evaluateConditions() {
    for (const trigger of userData.triggers) {
      if (!trigger.enabled || isAlertSource(trigger.event.type)) {
        continue;
      }
      if (!this.passesCooldown(trigger)) {
        continue;
      }
      if (evaluateTriggerCondition(trigger.event)) {
        this.fire(trigger);
      }
    }
  }

  private passesCooldown(trigger: UserData.TriggerData) {
    const cooldown = Math.max(trigger.cooldownMin * 60_000, MIN_COOLDOWN_MS);
    return trigger.lastRun === undefined || Date.now() - trigger.lastRun >= cooldown;
  }

  private fire(trigger: UserData.TriggerData, detail?: string) {
    trigger.lastRun = Date.now();
    trigger.runCount = (trigger.runCount ?? 0) + 1;

    const pkg = userData.actionPackages.find(x => x.global.name === trigger.packageName);
    if (!pkg) {
      // 目标操作包不存在（已删除/改名）：记录后跳过，待用户在面板中修正。
      trigger.lastResult = 'NO_PACKAGE';
      return;
    }
    trigger.lastResult = undefined;

    const isAuto = trigger.mode === 'AUTO' && userData.settings.triggers.autoEnabled;
    if (isAuto) {
      this.execute(trigger.id, pkg.global.name);
    } else {
      this.confirm(trigger, pkg.global.name, detail);
    }
  }

  private execute(triggerId: string, packageName: string) {
    queueTriggerRun({ triggerId, packageName });
    showBuffer(`XIT ACT_${packageName.replace(' ', '_')}`);
  }

  private confirm(trigger: UserData.TriggerData, packageName: string, detail?: string) {
    if (Notification.permission !== 'granted') {
      return;
    }
    const notification = new Notification('APEX — 自动触发器', {
      body: `「${trigger.name}」已触发${detail ? `：${detail}` : ''}。点击执行操作包「${packageName}」。`,
      tag: `rprun-trigger-${trigger.id}`,
      icon: '/favicon.ico',
    });
    notification.onclick = () => {
      window.focus();
      this.execute(trigger.id, packageName);
    };
  }
}

export const triggerEngine = new TriggerEngine();
