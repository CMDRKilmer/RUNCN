import { onAnyApiMessage, onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

// 天体位置 store。
// 主要来源：SFC 飞行计划（SHIP_FLIGHT_MISSION）中 TRANSIT 段的 transferEllipse ——
// startPosition/targetPosition 即出发/目标天体的绝对坐标。注意 MS 星系地图
// 不下发绝对坐标（行星沿轨道运动，客户端按轨道根数渲染），对全部 API 消息的
// 有界深度嗅探仅作补充来源。
// 捕获结果用于 FTC 的跨星系飞行时间估算；未捕获到时估算层自动降级。

// 触发响应式更新的版本号：任何天体位置新增/变化时自增。
export const bodiesVersion = ref(0);

// 已捕获到位置数据的消息类型（诊断用，显示在 FTC 探测结果里）。
export const detectedPositionMessages = ref<string[]>([]);

const positions = new Map<string, PrunApi.Position>();

function isPosition(value: unknown): value is PrunApi.Position {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    Number.isFinite(p.x as number) &&
    Number.isFinite(p.y as number) &&
    Number.isFinite(p.z as number)
  );
}

function isSamePosition(a: PrunApi.Position, b: PrunApi.Position) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function recordBody(id: string, position: PrunApi.Position, messageType: string) {
  const key = id.toUpperCase();
  const existing = positions.get(key);
  if (existing && isSamePosition(existing, position)) {
    return;
  }
  positions.set(key, position);
  bodiesVersion.value++;
  if (!detectedPositionMessages.value.includes(messageType)) {
    detectedPositionMessages.value = [...detectedPositionMessages.value, messageType];
  }
}

function sniff(value: unknown, depth: number, messageType: string) {
  if (depth > 6) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      sniff(item, depth + 1, messageType);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const obj = value as Record<string, unknown>;
  const id = obj.naturalId ?? obj.NaturalId ?? obj.PlanetNaturalId ?? obj.id;
  if (typeof id === 'string' && id !== '' && isPosition(obj.position)) {
    recordBody(id, obj.position, messageType);
  }
  for (const child of Object.values(obj)) {
    sniff(child, depth + 1, messageType);
  }
}

onAnyApiMessage(message => {
  if (message.data === undefined || message.data === null) {
    return;
  }
  sniff(message.data, 0, message.type);
});

// 取地址中最深层实体（行星/卫星）的 naturalId。
function locationEntityId(address?: PrunApi.Address): string | undefined {
  if (!address) {
    return undefined;
  }
  for (let i = address.lines.length - 1; i >= 0; i--) {
    const entity = address.lines[i]?.entity;
    if (entity?.naturalId) {
      return entity.naturalId;
    }
  }
  return undefined;
}

// 从飞行计划各段的 transferEllipse 提取天体位置：
// startPosition = 出发天体在出发时刻的位置，targetPosition = 目标天体在到达时刻的位置。
function recordFromFlightPlan(segments: PrunApi.FlightSegment[]) {
  for (const segment of segments) {
    const ellipse = segment.transferEllipse;
    if (!ellipse) {
      continue;
    }
    const originId = locationEntityId(segment.origin);
    if (originId) {
      recordBody(originId, ellipse.startPosition, 'SHIP_FLIGHT_MISSION');
    }
    const destinationId = locationEntityId(segment.destination);
    if (destinationId) {
      recordBody(destinationId, ellipse.targetPosition, 'SHIP_FLIGHT_MISSION');
    }
  }
}

onApiMessage({
  SHIP_FLIGHT_MISSION(data: PrunApi.FlightPlan) {
    recordFromFlightPlan(data.segments);
  },
});

export const systemBodiesStore = {
  // 读取天体位置。读取前访问 bodiesVersion.value 以建立响应式依赖。
  getPosition(naturalId?: string | null): PrunApi.Position | undefined {
    void bodiesVersion.value;
    if (!naturalId) {
      return undefined;
    }
    return positions.get(naturalId.toUpperCase());
  },
  get count(): number {
    void bodiesVersion.value;
    return positions.size;
  },
};
