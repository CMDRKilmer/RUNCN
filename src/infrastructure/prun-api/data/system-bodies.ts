import { onAnyApiMessage, onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

// 天体位置 store。
// 主要来源：SFC 飞行计划（SHIP_FLIGHT_MISSION）中 TRANSIT 段的 transferEllipse ——
// startPosition/targetPosition 即出发/目标天体的绝对坐标。注意 MS 星系地图
// 不下发绝对坐标（行星沿轨道运动，客户端按轨道根数渲染），对全部 API 消息的
// 有界深度嗅探仅作补充来源。
// 捕获结果用于 FTC 的跨星系飞行时间估算；未捕获到时估算层自动降级。

// 带时间戳的观测（供轨道相位标定）：位置 + 对应的游戏世界时刻。
export interface BodyObservation {
  position: PrunApi.Position;
  timestampMs: number;
}

// 触发响应式更新的版本号：任何天体位置新增/变化时自增。
export const bodiesVersion = ref(0);

// 游戏世界时间与本地时间的偏差（游戏时间戳 - Date.now()），由最近一份
// 飞行计划的首段出发时刻标定（SFC 计划按立即出发计算）。轨道预测用同一时钟。
export const gameClockOffsetMs = ref(0);

// 已捕获到位置数据的消息类型（诊断用，显示在 FTC 探测结果里）。
export const detectedPositionMessages = ref<string[]>([]);

const positions = new Map<string, PrunApi.Position>();
// 每个天体保留最近若干次带时间戳的观测（升序，最新在末尾）。
const observations = new Map<string, BodyObservation[]>();
const MAX_OBSERVATIONS_PER_BODY = 5;

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
  persist();
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
      recordObservation(originId, ellipse.startPosition, segment.departure.timestamp);
    }
    const destinationId = locationEntityId(segment.destination);
    if (destinationId) {
      recordBody(destinationId, ellipse.targetPosition, 'SHIP_FLIGHT_MISSION');
      recordObservation(destinationId, ellipse.targetPosition, segment.arrival.timestamp);
    }
  }
}

function recordObservation(id: string, position: PrunApi.Position, timestampMs: number) {
  const key = id.toUpperCase();
  const list = observations.get(key) ?? [];
  const last = list.at(-1);
  if (last && last.timestampMs === timestampMs) {
    return;
  }
  list.push({ position, timestampMs });
  while (list.length > MAX_OBSERVATIONS_PER_BODY) {
    list.shift();
  }
  observations.set(key, list);
  bodiesVersion.value++;
  persist();
}

onApiMessage({
  SHIP_FLIGHT_MISSION(data: PrunApi.FlightPlan) {
    recordFromFlightPlan(data.segments);
    // SFC 计划按立即出发计算：首段出发时刻 ≈ 服务器当前游戏时间。
    const first = data.segments[0];
    if (first !== undefined) {
      gameClockOffsetMs.value = first.departure.timestamp - Date.now();
    }
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
  // 带时间戳的观测列表（升序），供轨道相位标定。
  getObservations(naturalId?: string | null): BodyObservation[] {
    void bodiesVersion.value;
    if (!naturalId) {
      return [];
    }
    return observations.get(naturalId.toUpperCase()) ?? [];
  },
  get count(): number {
    void bodiesVersion.value;
    return positions.size;
  },
};

// ---- 快照持久化 ----
// 观测（位置 + 游戏世界时间戳）与静态位置跨会话保留：插件重启后
// predictPosition 仍可用历史观测标定相位，无需重新捕获。观测时间是
// 游戏世界时刻（跨会话连续），持久化安全。
const CACHE_KEY = 'rprun.ftc.bodies.v1';

let persistTimer: number | undefined;
function persist() {
  if (persistTimer !== undefined) {
    return;
  }
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ positions: [...positions], observations: [...observations] }),
      );
    } catch {
      // localStorage 不可用（隐私模式等）：仅内存缓存。
    }
  }, 1000);
}

function restore() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw) as {
      positions?: [string, PrunApi.Position][];
      observations?: [string, BodyObservation[]][];
    };
    let restored = 0;
    for (const [id, pos] of data.positions ?? []) {
      if (typeof id === 'string' && isPosition(pos)) {
        positions.set(id.toUpperCase(), pos);
        restored++;
      }
    }
    for (const [id, list] of data.observations ?? []) {
      if (
        typeof id === 'string' &&
        Array.isArray(list) &&
        list.some(x => isPosition(x?.position) && Number.isFinite(x.timestampMs))
      ) {
        observations.set(
          id.toUpperCase(),
          list.filter(x => isPosition(x.position) && Number.isFinite(x.timestampMs)),
        );
        restored++;
      }
    }
    if (restored > 0) {
      bodiesVersion.value++;
    }
  } catch {
    // 缓存损坏：忽略，重新积累。
  }
}
restore();
