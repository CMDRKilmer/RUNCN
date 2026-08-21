import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';

// 触发器事件源分两类：
// - 告警源：游戏推送的新告警触发一次（按告警 ID 去重，天然边缘触发）
// - 条件源：条件持续为真且冷却到期即触发（电平语义，靠冷却防抖）

interface AlertSource {
  alertTypes: PrunApi.AlertType[];
  matches: (event: UserData.TriggerEventData, alert: PrunApi.Alert) => boolean;
  describe: (alert: PrunApi.Alert) => string;
}

function alertData(alert: PrunApi.Alert, key: string): unknown {
  return alert.data.find(x => x.key === key)?.value;
}

function alertEntityNaturalId(alert: PrunApi.Alert): string | undefined {
  const wrapped = (alertData(alert, 'planet') ?? alertData(alert, 'address')) as
    { address: PrunApi.Address } | undefined;
  return wrapped ? getEntityNaturalIdFromAddress(wrapped.address) : undefined;
}

function matchesPlanet(event: { planet?: string }, alert: PrunApi.Alert) {
  return event.planet === undefined || alertEntityNaturalId(alert) === event.planet;
}

export const alertSources: Partial<Record<string, AlertSource>> = {
  FLIGHT_ENDED: {
    alertTypes: ['SHIP_FLIGHT_ENDED'],
    matches: (event, alert) =>
      event.type !== 'FLIGHT_ENDED' ||
      event.ship === undefined ||
      alertData(alert, 'registration') === event.ship,
    describe: alert => `舰只 ${String(alertData(alert, 'registration') ?? '')} 已到达`,
  },
  SUPPLIES_LOW: {
    alertTypes: ['WORKFORCE_LOW_SUPPLIES', 'WORKFORCE_OUT_OF_SUPPLIES'],
    matches: (event, alert) => event.type === 'SUPPLIES_LOW' && matchesPlanet(event, alert),
    describe: () => '劳动力物资告急',
  },
  PRODUCTION_FINISHED: {
    alertTypes: ['PRODUCTION_ORDER_FINISHED'],
    matches: (event, alert) => event.type === 'PRODUCTION_FINISHED' && matchesPlanet(event, alert),
    describe: alert => `${String(alertData(alert, 'material') ?? '')} 生产完成`,
  },
};

// 是否为告警驱动的事件源（非告警源由条件轮询评估）。
export function isAlertSource(eventType: string) {
  return alertSources[eventType] !== undefined;
}

// 条件源求值：站点/建筑数据未加载时返回 false（不触发）。
export function evaluateTriggerCondition(event: UserData.TriggerEventData): boolean {
  switch (event.type) {
    case 'BUILDING_CONDITION': {
      const site = sitesStore.getByPlanetNaturalIdOrName(event.planet);
      if (!site) {
        return false;
      }
      return site.platforms.some(x => x.condition * 100 < event.belowPct);
    }
    case 'INTERVAL':
      // 周期即冷却时间，由引擎统一判断。
      return true;
    default:
      return false;
  }
}
