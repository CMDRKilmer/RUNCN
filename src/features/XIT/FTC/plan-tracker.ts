import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { flightPlansStore } from '@src/infrastructure/prun-api/data/flight-plans';
import {
  getEntityNaturalIdFromAddress,
  isSameAddress,
} from '@src/infrastructure/prun-api/data/addresses';

// 飞行计划到达追踪与按飞船地址匹配。
// FlightPlan 消息不带飞船标识（SFC 表格的 prun-id 是 UI 侧关联），
// 这里记录消息到达顺序，按「首段 origin 地址 = 飞船当前地址」匹配，
// 使读取不再依赖 DOM（离屏窗口的表格 prun-id 读取曾全部失败）。

const MAX_TRACKED = 100;

interface TrackedPlan {
  missionId: string;
  receivedMs: number;
}

const received: TrackedPlan[] = [];

onApiMessage({
  SHIP_FLIGHT_MISSION(data: PrunApi.FlightPlan) {
    received.push({ missionId: data.missionId, receivedMs: Date.now() });
    while (received.length > MAX_TRACKED) {
      received.shift();
    }
  },
});

function planFor(tracked: TrackedPlan) {
  const plan = flightPlansStore.getById(tracked.missionId);
  return plan !== undefined && plan.segments.length > 0 ? plan : undefined;
}

/**
 * 查找最近一份首段起点与指定地址一致的飞行计划（按消息到达时间倒序）。
 * sinceMs：只接受到达时间不早于该时间的计划（排除更早查询的残留）。
 * destinationId：可选，要求计划末段目的地实体与该 naturalId 一致。
 */
export function latestPlanForAddress(
  address: PrunApi.Address | null,
  sinceMs?: number,
  destinationId?: string,
): PrunApi.FlightPlan | undefined {
  if (!address) {
    return undefined;
  }
  for (let i = received.length - 1; i >= 0; i--) {
    const plan = planFor(received[i]);
    if (!plan || !isSameAddress(plan.segments[0].origin, address)) {
      continue;
    }
    if (destinationId !== undefined) {
      const last = plan.segments[plan.segments.length - 1];
      const destEntity = getEntityNaturalIdFromAddress(last.destination);
      if (destEntity?.toUpperCase() !== destinationId.toUpperCase()) {
        continue;
      }
    }
    if (sinceMs !== undefined && received[i].receivedMs < sinceMs) {
      // 该计划属于更早的查询；更早的记录只会更旧。
      return undefined;
    }
    return plan;
  }
  return undefined;
}
