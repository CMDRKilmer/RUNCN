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

// ---- 原生 STL 段数据（离港/进近距离与时长，服务器下发）----
// 游戏服务器计算跃迁点（在起终点恒星连线上），STL 离港/进近段距离由服务器
// 决定，离线无法精确复现（已探明：跃迁点确定性、随出发天体变化，与目标
// 恒星连线方向相关；同一出发天体的离港距离大致恒定 —— 行星≈63-74M km、
// 空间站≈21M km，但目标天体的影响不可忽略：自证数据里通配键
// `ZV-307A|*` = 74.33M km，同一出发天体的精确记录（同星系直飞离港段）
// = 68.0562M km，差 9.2%（旧注释写「<5%」与数据矛盾）。所以通配键只做
// 近似回退，精确键永远优先。
// 这里从 SFC/BTF 飞行计划记录原生值，FTC 优先复用，即可精确复现原生 STL 路程：
// - 跨星系：离港 = DEPARTURE 段 stlDistance/时长，按 (出发天体, 首跳目标星系) 记录
//           进近 = APPROACH 段 stlDistance/时长，按 (末跳来源星系, 目标天体) 记录
// - 同星系：计划没有 JUMP 段，键里拼不出首跳/末跳星系，按航线 (出发天体, 目标天体) 记录：
//           DEPARTURE/APPROACH 段（合成/旧结构）+ **转移（TRANSIT）段**（2026-09-23 起，
//           真实观测到的系内计划结构）。
//           段名/字段已核实：`PrunApi.SegmentType` 含有 'TRANSIT'（flights.types.d.ts 第 42 行），
//           `FlightSegment.stlDistance: number | null` 是段上的同一字段（同文件第 22 行）——
//           只有一个候选段名，与离港/进近完全同口径（不是另一种段结构）。
//           转移段的 stlDistance = **整段 STL 路程**（没有离港/进近两段拆分）：实测用户 SFC
//           原生计划 ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km / 43分59秒 /
//           2655 单位 STL，与直飞口径几何 101.7053M km 差 0.05% → 距离口径可比。
//           故记进同星系表的**独立字段 `transit`**（不塞进 depart/approach：那是「两段拆分」
//           的语义，塞进去等于伪造出不存在的离港/进近段）。
// ⚠️ 转移段的**燃料口径仍未标定** —— 记录 ≠ 可用（本轮只放开记录/展示）：
//   BTF 实测转移段燃料 = 2×0.49×罐×min(f,0.5)（与距离无关、f≥0.5 饱和；BTF 罐 1500、
//   d = 520.38M km、f=0.05 → 74u，而 C_F×f×d 会给 741u，差 10×）；而上面那条原生计划
//   2655u 在罐口径下（罐 3500）最大只到 0.98×3500×0.5 = 1715u（-35%），在 C_F×f×d 口径下
//   要 f≈0.92 才凑得出 2655 —— 两组**原生**数据用任何单一简单律都无法同时解释（详见
//   fuel-model.ts 的 ⚠️）。⇒ 同星系几何照记（原生数据，供展示/诊断），但
//   `missingModelInputs` 仍**拦住滑块写入**，直到做一次受控实测：BTF 固定航线/固定 f、
//   只换 STL 罐容量 —— 燃料随罐变 = 罐口径，不随罐变 = C_F×f×d 口径。
//   绝不能拿未标定的口径去写玩家滑块的 f（宁可不动，也不写假值）。
// 网关航线（无 DEPARTURE/APPROACH/JUMP 段）不记录，FTC 回退模型。
export interface StlSegmentRecord {
  distanceKm: number;
  seconds: number;
}
// 同星系（无跳）航线的原生段记录：同一份计划里可能只有一种结构的段。
// - depart/approach：DEPARTURE/APPROACH 两段拆分（合成/旧结构；真实系内计划里未见）；
// - transit：「转移」（TRANSIT）单段，**整段 STL 路程**（真实系内计划的结构，见文件头）。
// 三者字段口径一致（服务器原生 stlDistance + 段时长），但语义不同（拆分 vs 整段），
// 故分开存放，由 route-planner 决定怎么消费。
export interface SameSystemStlRecord {
  depart?: StlSegmentRecord;
  approach?: StlSegmentRecord;
  transit?: StlSegmentRecord;
}
const departRecords = new Map<string, StlSegmentRecord>();
const approachRecords = new Map<string, StlSegmentRecord>();
const sameSystemRecords = new Map<string, SameSystemStlRecord>();
const STL_CACHE_KEY = 'rprun.ftc.stl-segments.v1';

function systemNaturalId(address?: PrunApi.Address): string | undefined {
  for (const line of address?.lines ?? []) {
    if (line.type === 'SYSTEM') {
      return line.entity?.naturalId;
    }
  }
  return undefined;
}

// 单段 → 原生记录（stlDistance/时刻缺失或非正 → undefined，不记录）。
function stlSegmentRecord(segment?: PrunApi.FlightSegment): StlSegmentRecord | undefined {
  if (
    segment?.stlDistance == null ||
    !(segment.stlDistance > 0) ||
    segment.departure?.timestamp == null ||
    segment.arrival?.timestamp == null
  ) {
    return undefined;
  }
  return {
    distanceKm: segment.stlDistance,
    seconds: (segment.arrival.timestamp - segment.departure.timestamp) / 1000,
  };
}

function recordStlSegments(segments: PrunApi.FlightSegment[]) {
  const depart = segments.find(s => s.type === 'DEPARTURE');
  const approach = segments.find(s => s.type === 'APPROACH');
  // 系内计划的真实段结构：单段「转移」（TRANSIT）（段名/字段核实见文件头）。
  const transit = segments.find(s => s.type === 'TRANSIT');
  const firstJump = segments.find(s => s.type === 'JUMP');
  const lastJump = [...segments].reverse().find(s => s.type === 'JUMP');
  const departRec = stlSegmentRecord(depart);
  const approachRec = stlSegmentRecord(approach);
  const transitRec = stlSegmentRecord(transit);
  // 天体 id：优先离港/进近段（跨星系键正是它们），系内转移结构则取自转移段。
  const fromBody = locationEntityId(depart?.origin) ?? locationEntityId(transit?.origin);
  const toBody = locationEntityId(approach?.destination) ?? locationEntityId(transit?.destination);
  let changed = false;
  // 同星系直飞（无 JUMP）：按航线 (出发天体, 目标天体) 记录。该表只被同星系
  // （无跳）航线查询，与下面按跳键控的跨星系表互不干扰；各段可缺 —— 真实系内计划
  // 只有 TRANSIT（见文件头），DEPARTURE/APPROACH 结构仅合成用例覆盖。
  // 无首跳即无末跳（同一个 JUMP 段同时决定两者），故只查 firstJump。
  if (firstJump === undefined) {
    const fromSystem = systemNaturalId(depart?.origin) ?? systemNaturalId(transit?.origin);
    const toSystem =
      systemNaturalId(approach?.destination) ?? systemNaturalId(transit?.destination);
    if (
      fromBody !== undefined &&
      toBody !== undefined &&
      (departRec !== undefined || approachRec !== undefined || transitRec !== undefined) &&
      fromSystem !== undefined &&
      fromSystem.toUpperCase() === toSystem?.toUpperCase()
    ) {
      // 合并写入（同一航线先后出现不同结构时互补、不互相覆盖）。
      const key = `${fromBody.toUpperCase()}|${toBody.toUpperCase()}`;
      const prev = sameSystemRecords.get(key);
      sameSystemRecords.set(key, {
        depart: departRec ?? prev?.depart,
        approach: approachRec ?? prev?.approach,
        transit: transitRec ?? prev?.transit,
      });
      changed = true;
    }
  }
  const toStar = firstJump !== undefined ? systemNaturalId(firstJump.destination) : undefined;
  if (departRec !== undefined && fromBody !== undefined && toStar !== undefined) {
    departRecords.set(`${fromBody.toUpperCase()}|${toStar.toUpperCase()}`, departRec);
    changed = true;
  }
  const fromStar = lastJump !== undefined ? systemNaturalId(lastJump.origin) : undefined;
  if (approachRec !== undefined && toBody !== undefined && fromStar !== undefined) {
    approachRecords.set(`${fromStar.toUpperCase()}|${toBody.toUpperCase()}`, approachRec);
    changed = true;
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
  // 同星系（无跳）航线的原生段（离港/进近/转移），按 (出发天体, 目标天体) 键控（全大写）。
  // 同星系计划没有 JUMP 段，拼不出首跳/末跳星系的键，故单独一张表；只由无跳
  // 计划写入、只被无跳航线查询，跨星系键不受影响。
  getSameSystem(fromBody: string, toBody: string): SameSystemStlRecord | undefined {
    void bodiesVersion.value;
    return sameSystemRecords.get(`${fromBody.toUpperCase()}|${toBody.toUpperCase()}`);
  },
  get departureCount(): number {
    return departRecords.size;
  },
  get approachCount(): number {
    return approachRecords.size;
  },
  get sameSystemCount(): number {
    return sameSystemRecords.size;
  },
  // 带「转移」（TRANSIT）记录的键数：几何签名要用（见 sfc-auto-fuel-settings 的
  // geometrySignature）——同星系表条数在「同键补上转移段」时不变，只数条数会漏掉这次几何变化。
  get sameSystemTransitCount(): number {
    let count = 0;
    for (const rec of sameSystemRecords.values()) {
      if (rec.transit !== undefined) {
        count++;
      }
    }
    return count;
  },
};

// 导出已积累的 STL 段数据（供 build-stl-data.mjs 精简内置）。
// 键：跨星系离港 = "出发天体|首跳目标星系"、进近 = "末跳来源星系|目标天体"、
// 同星系 = "出发天体|目标天体"（全大写）。
export interface StlSegmentsExport {
  depart: [string, StlSegmentRecord][];
  approach: [string, StlSegmentRecord][];
  sameSystem: [string, SameSystemStlRecord][];
}

export function exportStlSegments(): StlSegmentsExport {
  return {
    depart: [...departRecords],
    approach: [...approachRecords],
    sameSystem: [...sameSystemRecords],
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
      sameSystem?: [string, { depart?: number; approach?: number; transit?: number }][];
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
    for (const [k, rec] of data.sameSystem ?? []) {
      if (typeof k === 'string' && rec !== undefined && !sameSystemRecords.has(k)) {
        const depart = bundledRecord(rec.depart);
        const approach = bundledRecord(rec.approach);
        const transit = bundledRecord(rec.transit);
        if (depart !== undefined || approach !== undefined || transit !== undefined) {
          sameSystemRecords.set(k, { depart, approach, transit });
        }
      }
    }
    bodiesVersion.value++;
  } catch {
    // 内置数据加载失败/无文件：忽略，靠运行记录。
  }
}
void loadBundledStlSegments();

// 内置数据的裸距离 → 记录（时长内置不含，置 0）。
function bundledRecord(distanceKm?: number): StlSegmentRecord | undefined {
  if (typeof distanceKm !== 'number' || !(distanceKm > 0)) {
    return undefined;
  }
  return { distanceKm, seconds: 0 };
}

// 校验持久化记录（distanceKm 必须为正有限数；旧格式/损坏项一律丢弃）。
function validRecord(rec?: StlSegmentRecord): StlSegmentRecord | undefined {
  if (rec === undefined || !Number.isFinite(rec.distanceKm) || !(rec.distanceKm > 0)) {
    return undefined;
  }
  return { distanceKm: rec.distanceKm, seconds: Number.isFinite(rec.seconds) ? rec.seconds : 0 };
}

let segmentsPersistTimer: number | undefined;
// 与上文 persist() 同口径的 1000ms 防抖：一份飞行计划就往三张表写记录，批量采集
// （BTF 扫描）时几十条连着来，否则每条记录都同步全量 JSON.stringify + setItem，
// 整体接近 O(n²) 的主线程阻塞。
function persistSegments() {
  if (segmentsPersistTimer !== undefined) {
    return;
  }
  segmentsPersistTimer = window.setTimeout(() => {
    segmentsPersistTimer = undefined;
    try {
      localStorage.setItem(
        STL_CACHE_KEY,
        JSON.stringify({
          depart: [...departRecords],
          approach: [...approachRecords],
          sameSystem: [...sameSystemRecords],
        }),
      );
    } catch {
      // localStorage 不可用：仅内存缓存。
    }
  }, 1000);
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
      sameSystem?: [string, SameSystemStlRecord][];
    };
    for (const [k, v] of data.depart ?? []) {
      const rec = validRecord(v);
      if (typeof k === 'string' && rec !== undefined) {
        departRecords.set(k.toUpperCase(), rec);
      }
    }
    for (const [k, v] of data.approach ?? []) {
      const rec = validRecord(v);
      if (typeof k === 'string' && rec !== undefined) {
        approachRecords.set(k.toUpperCase(), rec);
      }
    }
    // 同星系记录为后加字段：旧格式（无 sameSystem）直接跳过，向后兼容；
    // `transit` 为再后加字段，旧缓存（只有 depart/approach）解出 transit = undefined。
    for (const [k, v] of data.sameSystem ?? []) {
      const depart = validRecord(v?.depart);
      const approach = validRecord(v?.approach);
      const transit = validRecord(v?.transit);
      if (
        typeof k === 'string' &&
        (depart !== undefined || approach !== undefined || transit !== undefined)
      ) {
        sameSystemRecords.set(k.toUpperCase(), { depart, approach, transit });
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
