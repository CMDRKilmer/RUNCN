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
// - 任意航线（**首选**）：整条航线**所有** STL 段之和，按 (出发天体, 目标天体[, #gw])
//           记录（见 routeRecords；为什么首选它见下方「混合航线」段）
// - 跨星系（**回退**）：离港 = DEPARTURE 段 stlDistance/时长，按 (出发天体, 首跳目标星系) 记录
//           进近 = APPROACH 段 stlDistance/时长，按 (末跳**起点**星系, 目标天体) 记录
//           （2026-09-23 第 5 轮：该键仅作回退 —— 真实混合航线的 APPROACH 段在中间、
//           其 destination ≠ 最终目标，按首/末跳拼键必然失配；几何首选 routeRecords）
// - 同星系：计划没有 JUMP 段，键里拼不出首跳/末跳星系，按航线 (出发天体, 目标天体) 记录：
//           DEPARTURE/APPROACH 段（合成/旧结构）+ **转移（TRANSIT）段**（2026-09-23 起，
//           真实观测到的系内计划结构）。
//           段名/字段已核实：`PrunApi.SegmentType` 含有 'TRANSIT'（flights.types.d.ts 第 42 行），
//           `FlightSegment.stlDistance: number | null` 是段上的同一字段（同文件第 22 行）——
//           只有一个候选段名，与离港/进近完全同口径（不是另一种段结构）。
//           转移段的 stlDistance = **整段 STL 路程**（没有离港/进近两段拆分）：实测用户 SFC
//           原生计划 ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km / 43分59秒 /
//           2655 单位 STL。
//           （旧注释此处比「与直飞口径几何 101.7053M km 差 0.05%」—— **已作废**：101.7053M
//           是**已删除的自建轨道模型**的估算行（68.0562M + 33.6491M），不是原生值，
//           跨样本比较无效；规则：文案里的数字一律现算。）
//           故记进同星系表的**独立字段 `transit`**（不塞进 depart/approach：那是「两段拆分」
//           的语义，塞进去等于伪造出不存在的离港/进近段）。
// ✅ 转移段的**燃料与时长口径已标定**（2026-09-23，BTF 受控数据）—— 记录即可用：
//   燃料 = **罐口径** 2×0.49×罐×min(f,0.5) = 0.98×罐×min(f,0.5)：与距离/载重无关、
//   f ≥ 0.5 饱和（28 点最大误差 3.3%）；旧解读里的 `C_F×f×d` 口径**已被证伪**
//   （同一航线高 10.0×）。
//   时长 = d / (V_SAT(引擎) × (min(f,0.5)/0.5)^k(引擎) × (整备质量/当前质量)^0.75 × 3600) / 状况
//   （§2 标准引擎 12 点最大误差 8.8%、§1 质量曲线 9.4%）；旧「巡航速度」模型已被取代。
//   ⇒ 同星系几何照记（原生数据）**且可以用于写滑块**：`missingModelInputs` 对系内航线
//   只剩两条判缺理由 —— ① 原生转移段记录还没到（`stlDistanceKm` 缺失/为 0）；
//   ② STL 罐容量/余量缺失（`ship.stlRemaining ?? ship.stlFuelCapacity` 为 undefined/≤0）。
//   （标定式、误差与用户原生样本的交叉验证见 fuel-model.ts 的「系内转移段标定」块。）
// 网关航线**有** DEPARTURE/APPROACH 段（否则飞船到不了网关；去/回网关是星系内飞行），
// 但「与自然航线同构（DEPARTURE → JUMP|JUMP_GATEWAY → APPROACH）」**只在纯网关航线成立**。
// 混合航线（自然跃迁 + 网关跃迁）的真实段序（2026-09-23 用户 FTC 面板原生计划，
// AVI-06JVV ZV-194h → HRT 勾「启用网关」，共 16 段）：
//   0 起飞 / 1 离港 69.17M / 2 跃迁(自然) / 3 充能 / 4 跃迁(自然) / 5 进近 67.47M
//   / 6 转移 0.01M / 7 锁定 / 8 网关跃迁 / 9 衰变 / 10 转移 0.01M / 11 锁定
//   / 12 网关跃迁 / 13 衰变 / 14 转移 0.01M / 15 转移 93.43M（真正到站段）
// ⇒ APPROACH 在**中间**且 destination = `Antares I - Hephaestus` ≠ 最终目标 `Hortus Station`；
// 到站段是 TRANSIT；首跳是自然跳、末跳是网关跃迁（拼出混合后缀）。
// 故按 (出发天体, 首跳星系) / (末跳星系, 目标天体) 拼的键**必然失配** —— 这是用户症状
// 「SFC 选择地址后没有计算燃料」的根因。故几何**首选**航线级 routeRecords，
// 下面这套按跳拼的键仅作回退（内置通配/单跳自然航线），键后缀仍按各自 jump 段类型
// 加 `#gw` 区分口径（见 GW_KEY_SUFFIX）。
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
// 航线级 STL 记录：整条航线**所有** STL 段（TAKE_OFF/DEPARTURE/APPROACH/TRANSIT）的距离/时长之和，
// 按 (出发天体, 目标天体[, #gw]) 键控。
// 为什么必须按「航线」而不是按「首跳/末跳」：真实段结构证明二者不对应 —— 实测用户
// AVI-06JVV ZV-194h → HRT（勾网关）的原生计划共 16 段：
//   0 起飞 / 1 离港 69.1655M / 2 跃迁(自然) / 3 充能 / 4 跃迁(自然) / 5 进近 67.4728M
//   / 6 转移 0.01M / 7 锁定 / 8 网关跃迁 / 9 衰变 / 10 转移 0.01M / 11 锁定
//   / 12 网关跃迁 / 13 衰变 / 14 转移 0.01M / 15 转移 93.4251M（真正到站段）
// ⇒ APPROACH 在中间且其 destination ≠ 最终目标；到站段是 TRANSIT；首跳是自然、末跳是网关。
// 旧实现按 (出发天体, 首跳星系) / (末跳星系, 目标天体) 拼键 → 必然失配（用户症状的根因）。
const routeRecords = new Map<string, StlSegmentRecord>();
// 网关航线记录的键后缀：同一对 (出发天体, 目标星系) 的自然航线与网关航线几何**不同**
// （自然离港 = 飞船 → 跃迁点（在起终点恒星连线上）；网关离港 = 飞船 → 网关（绕行星轨道，
// 星系内，实测比自然低 35-50%））。键不加区分会互相覆盖 —— 玩家在 FTC/SFC 切换「使用
// 跃迁点」时会串味。自然键保持原样（既有内置数据与持久化缓存零失效），网关键加此后缀。
const GW_KEY_SUFFIX = '#gw';
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
  // 首/末跳：自然航线是 JUMP，网关航线是 JUMP_GATEWAY（段结构同构**只在纯网关航线成立**，
  // 混合航线见文件头 16 段真实表 —— 故这套按跳拼的键只是回退）。JUMP_GATEWAY 段的
  // origin/destination 各含一条 SYSTEM 行 = 网关两端星系（见 infrastructure/fio/routes.ts 文件头）。
  // 旧实现只认 'JUMP' → 网关航线的离港/进近段一条都不写 → 几何永远判缺
  // （实机症状「SFC 选择地址后没有计算燃料」的直接成因）。
  // ⚠️ 首末跳**分别**判定后缀：混合航线（自然跳 + 网关跃迁）两段类型可能不同。
  const isJump = (s: PrunApi.FlightSegment) => s.type === 'JUMP' || s.type === 'JUMP_GATEWAY';
  const firstJump = segments.find(isJump);
  const lastJump = [...segments].reverse().find(isJump);
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
  // 键后缀按**各自** jump 段的类型（网关 / 自然）—— 混合航线的首末跳可能不同。
  const departGw = firstJump?.type === 'JUMP_GATEWAY' ? GW_KEY_SUFFIX : '';
  const approachGw = lastJump?.type === 'JUMP_GATEWAY' ? GW_KEY_SUFFIX : '';
  const toStar = firstJump !== undefined ? systemNaturalId(firstJump.destination) : undefined;
  if (departRec !== undefined && fromBody !== undefined && toStar !== undefined) {
    departRecords.set(`${fromBody.toUpperCase()}|${toStar.toUpperCase()}${departGw}`, departRec);
    changed = true;
  }
  // 进近键的星系分量 = 末跳【起点】星系（**仅回退用**：第 4 轮曾改成「到达星系」，
  // 2026-09-23 第 5 轮按真实段结构回退 —— 混合航线的 APPROACH 段在中间、destination
  // 不是最终目标，该键无论如何都命不中；几何**首选**来源是 routeRecords）。
  const fromStar = lastJump !== undefined ? systemNaturalId(lastJump.origin) : undefined;
  if (approachRec !== undefined && toBody !== undefined && fromStar !== undefined) {
    approachRecords.set(
      `${fromStar.toUpperCase()}|${toBody.toUpperCase()}${approachGw}`,
      approachRec,
    );
    changed = true;
  }
  // 航线级记录：Σ 所有带 stlDistance 的 STL 段。出发天体取**首段 origin**、目标天体取
  // **末段 destination**（不是 APPROACH 段的 —— 见上方表：APPROACH 可能在中间）。
  // 键后缀统一按「整条航线是否含 JUMP_GATEWAY」判定（混合航线的首末跳类型可能不同）。
  const stlSegs = segments.filter(s => (s.stlDistance ?? 0) > 0);
  if (stlSegs.length > 0 && segments.length > 0) {
    const fromEntity = locationEntityId(segments[0]?.origin);
    const toEntity = locationEntityId(segments[segments.length - 1]?.destination);
    if (fromEntity !== undefined && toEntity !== undefined) {
      const hasGateway = segments.some(s => s.type === 'JUMP_GATEWAY');
      const sumKm = stlSegs.reduce((a, s) => a + (s.stlDistance ?? 0), 0);
      const sumSec = stlSegs.reduce(
        (a, s) => a + ((s.arrival?.timestamp ?? 0) - (s.departure?.timestamp ?? 0)) / 1000,
        0,
      );
      routeRecords.set(
        `${fromEntity.toUpperCase()}|${toEntity.toUpperCase()}${hasGateway ? GW_KEY_SUFFIX : ''}`,
        { distanceKm: sumKm, seconds: sumSec },
      );
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
  // ⚠️ 网关模式（viaGateway）只认精确键 `BODY|STAR#gw`，**不做通配回退**：通配键是
  // **自然口径**（飞船 → 跃迁点），用于网关必然高估（网关离港实测低 35-50%）。
  // 查不到即 undefined → 由 missingModelInputs 判缺（宁可不动，也不写不准的值）。
  getDeparture(fromBody: string, toStar: string, viaGateway = false): StlSegmentRecord | undefined {
    void bodiesVersion.value;
    const bodyKey = fromBody.toUpperCase();
    const starKey = toStar.toUpperCase();
    if (viaGateway) {
      return departRecords.get(`${bodyKey}|${starKey}${GW_KEY_SUFFIX}`);
    }
    return departRecords.get(`${bodyKey}|${starKey}`) ?? departRecords.get(`${bodyKey}|*`);
  },
  // 进近距离/时长（末跳**起点**星系 → 目标天体）。**仅回退用**：混合航线按此键必然失配
  // （见 routeRecords），几何首选来源是 getRoute。
  // 精确键优先；无记录时回退到按目标天体的通配键（"*|BODY"）。
  // ⚠️ 网关模式同 getDeparture：只认精确键 `STAR|BODY#gw`（网关进近同样是星系内绕行星段，
  // 通配的自然口径会高估），查不到即 undefined。
  getApproach(fromStar: string, toBody: string, viaGateway = false): StlSegmentRecord | undefined {
    void bodiesVersion.value;
    const starKey = fromStar.toUpperCase();
    const bodyKey = toBody.toUpperCase();
    if (viaGateway) {
      return approachRecords.get(`${starKey}|${bodyKey}${GW_KEY_SUFFIX}`);
    }
    return approachRecords.get(`${starKey}|${bodyKey}`) ?? approachRecords.get(`*|${bodyKey}`);
  },
  // 航线级 STL 总路程/总时长（整条航线所有 STL 段之和），按 (出发天体, 目标天体[, #gw]) 键控。
  // 这是**首选**几何来源：对系内/纯自然/纯网关/混合四种形态统一适用（见 routeRecords 声明处）。
  getRoute(fromBody: string, toBody: string, viaGateway = false): StlSegmentRecord | undefined {
    void bodiesVersion.value;
    const key = `${fromBody.toUpperCase()}|${toBody.toUpperCase()}${viaGateway ? GW_KEY_SUFFIX : ''}`;
    return routeRecords.get(key);
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
  // 航线级表条数：几何签名要用（sfc-auto-fuel-settings 的 geometrySignature）——
  // 新航线写入不改变上面三张表的条数，漏掉这一项会让推送门误判「几何没变」而 settled。
  get routeCount(): number {
    return routeRecords.size;
  },
};

// 导出已积累的 STL 段数据（供 build-stl-data.mjs 精简内置）。
// 键：跨星系离港 = "出发天体|首跳目标星系"、进近 = "末跳起点星系|目标天体"、
// 同星系 = "出发天体|目标天体"、航线级 = "出发天体|目标天体"（全大写；
// 网关航线用同样的键 + "#gw" 后缀）。
export interface StlSegmentsExport {
  depart: [string, StlSegmentRecord][];
  approach: [string, StlSegmentRecord][];
  sameSystem: [string, SameSystemStlRecord][];
  route: [string, StlSegmentRecord][];
}

export function exportStlSegments(): StlSegmentsExport {
  return {
    depart: [...departRecords],
    approach: [...approachRecords],
    sameSystem: [...sameSystemRecords],
    route: [...routeRecords],
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
          route: [...routeRecords],
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
      route?: [string, StlSegmentRecord][];
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
    // 航线级记录同为后加字段：旧缓存无 route → 跳过（新表从空开始，靠服务器重新下发重建）。
    for (const [k, v] of data.route ?? []) {
      const rec = validRecord(v);
      if (typeof k === 'string' && rec !== undefined) {
        routeRecords.set(k.toUpperCase(), rec);
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
