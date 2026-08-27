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

// ---- 原生 STL 段数据（跨星系自然航线的离港/进近距离与时长）----
// 游戏服务器计算跃迁点（在起终点恒星连线上），STL 离港/进近段距离由服务器
// 决定，离线无法精确复现（已探明：跃迁点确定性、随出发天体变化，与目标
// 恒星连线方向相关；同一出发天体的离港距离基本恒定，行星≈63-74M km、
// 空间站≈21M km，目标依赖 <5%）。
// 这里从 SFC/BTF 飞行计划记录原生值，FTC 优先复用，即可精确复现原生 STL 路程：
// - 离港 = DEPARTURE 段 stlDistance/时长，按 (出发天体, 首跳目标星系) 记录
// - 进近 = APPROACH 段 stlDistance/时长，按 (末跳来源星系, 目标天体) 记录
// 网关航线（TRANSIT 结构，无 DEPARTURE/APPROACH/JUMP 段）不记录，FTC 回退模型。
export interface StlSegmentRecord {
  distanceKm: number;
  seconds: number;
}
const departRecords = new Map<string, StlSegmentRecord>();
const approachRecords = new Map<string, StlSegmentRecord>();
const STL_CACHE_KEY = 'rprun.ftc.stl-segments.v1';

function systemNaturalId(address?: PrunApi.Address): string | undefined {
  for (const line of address?.lines ?? []) {
    if (line.type === 'SYSTEM') {
      return line.entity?.naturalId;
    }
  }
  return undefined;
}

function recordStlSegments(segments: PrunApi.FlightSegment[]) {
  const depart = segments.find(s => s.type === 'DEPARTURE');
  const approach = segments.find(s => s.type === 'APPROACH');
  const firstJump = segments.find(s => s.type === 'JUMP');
  const lastJump = [...segments].reverse().find(s => s.type === 'JUMP');
  let changed = false;
  if (
    depart?.stlDistance != null &&
    depart.stlDistance > 0 &&
    depart.departure?.timestamp != null &&
    depart.arrival?.timestamp != null
  ) {
    const fromBody = locationEntityId(depart.origin);
    const toStar = firstJump ? systemNaturalId(firstJump.destination) : undefined;
    if (fromBody && toStar) {
      departRecords.set(`${fromBody.toUpperCase()}|${toStar.toUpperCase()}`, {
        distanceKm: depart.stlDistance,
        seconds: (depart.arrival.timestamp - depart.departure.timestamp) / 1000,
      });
      changed = true;
    }
  }
  if (
    approach?.stlDistance != null &&
    approach.stlDistance > 0 &&
    approach.departure?.timestamp != null &&
    approach.arrival?.timestamp != null
  ) {
    const toBody = locationEntityId(approach.destination);
    const fromStar = lastJump ? systemNaturalId(lastJump.origin) : undefined;
    if (toBody && fromStar) {
      approachRecords.set(`${fromStar.toUpperCase()}|${toBody.toUpperCase()}`, {
        distanceKm: approach.stlDistance,
        seconds: (approach.arrival.timestamp - approach.departure.timestamp) / 1000,
      });
      changed = true;
    }
  }
  if (changed) {
    bodiesVersion.value++;
    persistSegments();
  }
}

export const stlSegmentsStore = {
  // 离港距离/时长（出发天体 → 首跳目标星系）。
  // 精确键优先；无记录时回退到按出发天体的通配键（"BODY|*"，内置批量采集数据），
  // 让同一出发天体到任意自然目标星系都能复用近似值。
  getDeparture(fromBody: string, toStar: string): StlSegmentRecord | undefined {
    void bodiesVersion.value;
    const starKey = toStar.toUpperCase();
    return (
      departRecords.get(`${fromBody.toUpperCase()}|${starKey}`) ??
      departRecords.get(`${fromBody.toUpperCase()}|*`)
    );
  },
  // 进近距离/时长（末跳来源星系 → 目标天体）。
  // 精确键优先；无记录时回退到按目标天体的通配键（"*|BODY"）。
  getApproach(fromStar: string, toBody: string): StlSegmentRecord | undefined {
    void bodiesVersion.value;
    const bodyKey = toBody.toUpperCase();
    return (
      approachRecords.get(`${fromStar.toUpperCase()}|${bodyKey}`) ??
      approachRecords.get(`*|${bodyKey}`)
    );
  },
  get departureCount(): number {
    return departRecords.size;
  },
  get approachCount(): number {
    return approachRecords.size;
  },
};

// 导出已积累的 STL 段数据（供 build-stl-data.mjs 精简内置）。
// 键：离港 = "出发天体|首跳目标星系"，进近 = "末跳来源星系|目标天体"（全大写）。
export interface StlSegmentsExport {
  depart: [string, StlSegmentRecord][];
  approach: [string, StlSegmentRecord][];
}

export function exportStlSegments(): StlSegmentsExport {
  return {
    depart: [...departRecords],
    approach: [...approachRecords],
  };
}

// 内置数据（public/json/stl-segments.json，由 build-stl-data.mjs 生成）：
// 从用户批量采集（SFC/BTF 计划各相关天体）导出后精简，只保留与飞船无关的
// 段距离（时长随飞船变，不内置）。启动时作种子，运行时记录（校准）优先填
// 缺失项并持续覆盖。
async function loadBundledStlSegments() {
  try {
    const resp = await fetch(config.url.stlSegments);
    const data = (await resp.json()) as {
      depart?: [string, number][];
      approach?: [string, number][];
    };
    for (const [k, d] of data.depart ?? []) {
      if (typeof k === 'string' && typeof d === 'number' && d > 0 && !departRecords.has(k)) {
        departRecords.set(k, { distanceKm: d, seconds: 0 });
      }
    }
    for (const [k, d] of data.approach ?? []) {
      if (typeof k === 'string' && typeof d === 'number' && d > 0 && !approachRecords.has(k)) {
        approachRecords.set(k, { distanceKm: d, seconds: 0 });
      }
    }
    bodiesVersion.value++;
  } catch {
    // 内置数据加载失败/无文件：忽略，靠运行记录。
  }
}
void loadBundledStlSegments();

function persistSegments() {
  try {
    localStorage.setItem(
      STL_CACHE_KEY,
      JSON.stringify({ depart: [...departRecords], approach: [...approachRecords] }),
    );
  } catch {
    // localStorage 不可用：仅内存缓存。
  }
}

function restoreSegments() {
  try {
    const raw = localStorage.getItem(STL_CACHE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw) as {
      depart?: [string, StlSegmentRecord][];
      approach?: [string, StlSegmentRecord][];
    };
    for (const [k, v] of data.depart ?? []) {
      if (
        typeof k === 'string' &&
        v !== undefined &&
        Number.isFinite(v.distanceKm) &&
        v.distanceKm > 0
      ) {
        departRecords.set(k, v);
      }
    }
    for (const [k, v] of data.approach ?? []) {
      if (
        typeof k === 'string' &&
        v !== undefined &&
        Number.isFinite(v.distanceKm) &&
        v.distanceKm > 0
      ) {
        approachRecords.set(k, v);
      }
    }
  } catch {
    // 缓存损坏：忽略，重新积累。
  }
}
restoreSegments();

onApiMessage({
  SHIP_FLIGHT_MISSION(data: PrunApi.FlightPlan) {
    recordFromFlightPlan(data.segments);
    recordStlSegments(data.segments);
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
