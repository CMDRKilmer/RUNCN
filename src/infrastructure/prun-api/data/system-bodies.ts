import { onAnyApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

// 行星/恒星位置嗅探 store。
// 游戏渲染星系地图（MS）时必须通过 socket 下发天体位置数据，但消息名与结构
// 未知（扩展现有 store 只登记了 SYSTEM_STARS_DATA 的恒星坐标）。这里对每条
// API 消息做有界深度扫描，捕获任何携带 position {x,y,z} + naturalId 的对象。
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
