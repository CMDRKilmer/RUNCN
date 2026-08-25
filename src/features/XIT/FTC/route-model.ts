import { starsStore, getStarNaturalId } from '@src/infrastructure/prun-api/data/stars';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { systemBodiesStore } from '@src/infrastructure/prun-api/data/system-bodies';
import { getSystemLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { gameNow, predictPosition } from '@src/infrastructure/fio/orbit';

// 多段路线估算模型。
// 首段（飞船当前位置 → 第一个航点）由 SFC 查询获得服务器精确结果，
// 其余段用恒星星系坐标 + 天体位置外推：
// - FTL 充能时间按距离线性缩放，跃迁时间视为固定值
// - STL 时间按 sqrt(距离比) 缩放（匀加速转移轨道的一阶近似）
// - STL 燃料/损伤与时间同比例缩放（燃料 = 流量×时间，流量恒定 ∝ √距离）
// 天体位置优先按 FIO 轨道根数 + 观测相位预测该段出发/到达时刻的坐标
// （行星在轨道上运动，静态坐标会随时间漂移），无轨道数据时降级为最近
// 静态观测（transferEllipse 捕获）。
// 位置坐标与游戏距离单位可能不一致，换算系数用首段计划自标定：
// STL 用 TRANSIT 段 stlDistance/弦长，FTL 用 JUMP 段 ftlDistance/恒星距。
// 所有不精确的段在结果中标记 precise=false，UI 显示「≈」。

export interface Calibration {
  totalMs: number;
  stlMs: number;
  chargeMs: number;
  jumpMs: number;
  stlDistance: number;
  ftlDistance: number;
  stlFuel: number;
  ftlFuel: number;
  damage: number;
  // STL 段损伤合计（STL 飞行产生，随燃烧时长缩放）。
  damageStl: number;
  // FTL 段（充能/跃迁）损伤合计（随反应堆使用量缩放）。
  damageFtl: number;
  // 位置坐标 → 游戏 STL 距离单位的换算系数（无法标定时为 undefined）。
  stlScale?: number;
  // 位置坐标 → 游戏 FTL 距离单位的换算系数（无法标定时为 undefined）。
  ftlScale?: number;
}

export interface RouteLeg {
  from: string;
  to: string;
  precise: boolean;
  // 该段天体位置来自 FIO 轨道预测（否则为静态观测或常数外推）。
  orbitPredicted?: boolean;
  durationMs: number;
  stlFuel: number;
  ftlFuel: number;
  damage: number;
}

export interface RouteResult {
  legs: RouteLeg[];
  totalMs: number;
  totalStlFuel: number;
  totalFtlFuel: number;
  totalDamage: number;
  allPrecise: boolean;
}

// 将任意航点 naturalId 解析为所属星系 id：恒星级 id 直接命中，
// 空间站查其地址的 SYSTEM 行，行星去掉一颗卫星后缀，卫星再剥离
// 小写字母开头的后缀。
export function resolveSystemId(naturalId: string): string | undefined {
  const upper = naturalId.trim().toUpperCase();
  if (upper === '') {
    return undefined;
  }
  const star = starsStore.getByNaturalId(upper);
  if (star) {
    return getStarNaturalId(star);
  }
  const station = stationsStore.getByNaturalId(upper);
  const systemLine = station ? getSystemLineFromAddress(station.address) : undefined;
  if (systemLine) {
    return systemLine.entity.naturalId;
  }
  const byPlanet = starsStore.getByPlanetNaturalId(upper);
  if (byPlanet) {
    return getStarNaturalId(byPlanet);
  }
  const stripped = upper.replace(/[a-z][a-z0-9]*$/, '');
  if (stripped !== upper) {
    const moonStar = starsStore.getByNaturalId(stripped);
    if (moonStar) {
      return getStarNaturalId(moonStar);
    }
  }
  return undefined;
}

export function getStarPosition(systemId: string): PrunApi.Position | undefined {
  return starsStore.getByNaturalId(systemId)?.position;
}

export function distance3d(a: PrunApi.Position, b: PrunApi.Position) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// STL 段类型：起飞/离轨/转移/进近/着陆/漂浮。
const STL_SEGMENT_TYPES = new Set([
  'TAKE_OFF',
  'DEPARTURE',
  'TRANSIT',
  'APPROACH',
  'LANDING',
  'FLOAT',
  'LOCK',
  'DECAY',
]);

function starPositionFromAddress(address: PrunApi.Address): PrunApi.Position | undefined {
  const line = getSystemLineFromAddress(address);
  return line ? starsStore.getByNaturalId(line.entity.naturalId)?.position : undefined;
}

// 从服务器精确飞行计划提取标定数据。
export function calibrate(plan: PrunApi.FlightPlan): Calibration {
  let stlMs = 0;
  let chargeMs = 0;
  let jumpMs = 0;
  let damageStl = 0;
  let damageFtl = 0;
  let stlScale: number | undefined;
  let ftlScale: number | undefined;
  for (const segment of plan.segments) {
    const duration = segment.arrival.timestamp - segment.departure.timestamp;
    if (segment.type === 'CHARGE') {
      chargeMs += duration;
    } else if (segment.type === 'JUMP' || segment.type === 'JUMP_GATEWAY') {
      jumpMs += duration;
    } else if (STL_SEGMENT_TYPES.has(segment.type)) {
      stlMs += duration;
    }
    if (segment.type === 'CHARGE' || segment.type === 'JUMP' || segment.type === 'JUMP_GATEWAY') {
      damageFtl += segment.damage;
    } else {
      damageStl += segment.damage;
    }

    // 标定位置坐标与游戏距离单位的换算系数（各用首个可用段）。
    const stlDistance = segment.stlDistance;
    if (
      stlScale === undefined &&
      segment.transferEllipse !== null &&
      stlDistance !== null &&
      stlDistance > 0
    ) {
      const chord = distance3d(
        segment.transferEllipse.startPosition,
        segment.transferEllipse.targetPosition,
      );
      if (chord > 0) {
        stlScale = stlDistance / chord;
      }
    }
    const ftlDistance = segment.ftlDistance;
    if (
      ftlScale === undefined &&
      (segment.type === 'JUMP' || segment.type === 'JUMP_GATEWAY') &&
      ftlDistance !== null &&
      ftlDistance > 0
    ) {
      const fromStar = starPositionFromAddress(segment.origin);
      const toStar = starPositionFromAddress(segment.destination);
      if (fromStar !== undefined && toStar !== undefined) {
        const starDistance = distance3d(fromStar, toStar);
        if (starDistance > 0) {
          ftlScale = ftlDistance / starDistance;
        }
      }
    }
  }
  return {
    totalMs: plan.eta.millis,
    stlMs,
    chargeMs,
    jumpMs,
    stlDistance: plan.stlDistance ?? 0,
    ftlDistance: plan.ftlDistance ?? 0,
    stlFuel: plan.stlFuelConsumption ?? 0,
    ftlFuel: plan.ftlFuelConsumption ?? 0,
    damage: damageStl + damageFtl,
    damageStl,
    damageFtl,
    stlScale,
    ftlScale,
  };
}

// ---- 本地缩放模型 ----
//
// 把一份标定（滑块 f0/r0、质量 m0 下测得的服务器精确计划）缩放到任意参数组合。
// 规律来自 Hortus 同航线服务器数据实测（游戏未公开精确公式，仍属逼近）：
// - STL 燃料 ∝ 燃料滑块 f（线性）、∝ 航行距离，与质量基本无关：
//     fuel(f) = fuel0·(f/f0)。之前误用 √（Brachistochrone），0.1→1 少算了 √10 倍。
// - STL 时长 ∝ 质量^0.8 · 滑块^−0.85（空载 vs 满载、0.05 vs 0.1 实测指数），
//   而非 Brachistochrone 的 √(m/m0)·√(f0/f)。游戏 STL 不是 F=ma 匀加速，
//   有效航速远高于蓝图加速度（89.7 m/s²）所能解释。
// - STL 损伤由航线环境（小行星密度/辐射）决定，实测同航线不同滑块/质量下
//   转移损伤恒定 → 不随滑块/质量/时长缩放。
// - FTL 充能/跃迁速度 ∝ 反应堆使用量 r：t ∝ r0/r；FTL 燃料/损伤 ∝ r/r0。

export interface ComboScaleFrom {
  fuel: number;
  reactor: number;
  mass?: number;
}

export interface ComboScaleTo {
  fuel: number;
  reactor?: number;
  mass?: number;
}

export function scaleCalibration(
  cal: Calibration,
  from: ComboScaleFrom,
  to: ComboScaleTo,
): Calibration {
  const massRatio =
    from.mass !== undefined && to.mass !== undefined && from.mass > 0 && to.mass > 0
      ? Math.sqrt(to.mass / from.mass)
      : 1;
  // STL 时间 ∝ √(f0/f)·√(m/m0)；STL 燃料 ∝ √(f/f0)·√(m/m0)。
  const stlTimeRatio = Math.sqrt(from.fuel / to.fuel) * massRatio;
  const stlFuelRatio = Math.sqrt(to.fuel / from.fuel) * massRatio;
  // FTL 时间 ∝ r0/r；FTL 燃料/损伤 ∝ r/r0。
  const reactor = to.reactor ?? from.reactor;
  const ftlTimeRatio = from.reactor > 0 ? from.reactor / reactor : 1;
  const ftlCostRatio = from.reactor > 0 ? reactor / from.reactor : 1;

  const stlMs = cal.stlMs * stlTimeRatio;
  const chargeMs = cal.chargeMs * ftlTimeRatio;
  const jumpMs = cal.jumpMs * ftlTimeRatio;
  // totalMs 中可能含未归类的段（residual），按原样保留。
  const residualMs = Math.max(0, cal.totalMs - cal.stlMs - cal.chargeMs - cal.jumpMs);
  const damageStl = cal.damageStl * stlTimeRatio;
  const damageFtl = cal.damageFtl * ftlCostRatio;
  return {
    ...cal,
    totalMs: residualMs + stlMs + chargeMs + jumpMs,
    stlMs,
    chargeMs,
    jumpMs,
    stlFuel: cal.stlFuel * stlFuelRatio,
    ftlFuel: cal.ftlFuel * ftlCostRatio,
    damage: damageStl + damageFtl,
    damageStl,
    damageFtl,
  };
}

// 天体在指定游戏世界时刻的位置：优先 FIO 轨道预测，降级最近静态观测。
interface BodyPosition {
  position: PrunApi.Position;
  orbitPredicted: boolean;
}

function bodyPositionAt(naturalId: string, timestampMs: number): BodyPosition | undefined {
  const predicted = predictPosition(naturalId, timestampMs);
  if (predicted !== undefined) {
    return { position: predicted, orbitPredicted: true };
  }
  const position = systemBodiesStore.getPosition(naturalId);
  if (position !== undefined) {
    return { position, orbitPredicted: false };
  }
  return undefined;
}

// 跨星系段的 STL 距离：出发行星→本星恒星 + 目标恒星→目标行星。
// 任一侧天体位置已知即可估算；两侧都缺时返回 undefined（估算层按常数外推）。
function interSystemStlDistance(
  fromPos: BodyPosition | undefined,
  toPos: BodyPosition | undefined,
  fromStar: PrunApi.Position,
  toStar: PrunApi.Position,
) {
  const departure = fromPos !== undefined ? distance3d(fromPos.position, fromStar) : undefined;
  const approach = toPos !== undefined ? distance3d(toStar, toPos.position) : undefined;
  if (departure === undefined && approach === undefined) {
    return undefined;
  }
  return (departure ?? 0) + (approach ?? 0);
}

/**
 * 用首段标定数据估算整条路线。waypoints 为完整航点序列（含首段目的地）；
 * 首段直接使用标定数据（精确），其余段外推（precise=false）。
 * 各段按累计时长推进游戏世界时钟，天体位置取对应时刻的轨道预测值。
 */
export function estimateRoute(cal: Calibration, waypoints: string[]): RouteResult {
  const legs: RouteLeg[] = [];

  // 首段：标定数据即精确结果（锚点按当前航线捕获）。出发时刻按当前游戏
  // 时间计——扫描是预估，实际出发时刻由用户决定，偏差相对行星轨道周期可忽略。
  legs.push({
    from: '(当前位置)',
    to: waypoints[0],
    precise: true,
    durationMs: cal.totalMs,
    stlFuel: cal.stlFuel,
    ftlFuel: cal.ftlFuel,
    damage: cal.damage,
  });

  let clock = gameNow() + (legs[0]?.durationMs ?? cal.totalMs);
  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1];
    const to = waypoints[i];
    const leg = estimateLeg(cal, from, to, clock);
    if (leg !== undefined) {
      legs.push(leg);
      clock += leg.durationMs;
    } else {
      // 无法解析的段不输出，但时钟仍按首段时长推进，避免后续时刻严重偏早。
      clock += cal.totalMs;
    }
  }

  const totalMs = legs.reduce((sum, leg) => sum + leg.durationMs, 0);
  const totalStlFuel = legs.reduce((sum, leg) => sum + leg.stlFuel, 0);
  const totalFtlFuel = legs.reduce((sum, leg) => sum + leg.ftlFuel, 0);
  const totalDamage = legs.reduce((sum, leg) => sum + leg.damage, 0);
  return {
    legs,
    totalMs,
    totalStlFuel,
    totalFtlFuel,
    totalDamage,
    allPrecise: legs.every(x => x.precise),
  };
}

function estimateLeg(
  cal: Calibration,
  from: string,
  to: string,
  departureMs: number,
): RouteLeg | undefined {
  const fromSystem = resolveSystemId(from);
  const toSystem = resolveSystemId(to);
  if (!fromSystem || !toSystem) {
    return undefined;
  }

  const fromStar = getStarPosition(fromSystem);
  const toStar = getStarPosition(toSystem);
  if (!fromStar || !toStar) {
    return undefined;
  }

  const fromPos = bodyPositionAt(from, departureMs);

  if (fromSystem === toSystem) {
    // 同星系：纯 STL 段，两端位置取出发时刻。
    const toPos = bodyPositionAt(to, departureMs);
    const raw =
      fromPos !== undefined && toPos !== undefined
        ? distance3d(fromPos.position, toPos.position)
        : undefined;
    const d = raw !== undefined && cal.stlScale !== undefined ? raw * cal.stlScale : raw;
    const ratio = d !== undefined && cal.stlDistance > 0 ? d / cal.stlDistance : 1;
    const scale = Math.sqrt(ratio);
    return {
      from,
      to,
      precise: false,
      orbitPredicted: (fromPos?.orbitPredicted ?? false) || (toPos?.orbitPredicted ?? false),
      durationMs: cal.stlMs * scale,
      stlFuel: cal.stlFuel * scale,
      ftlFuel: 0,
      damage: cal.damageStl * scale,
    };
  }

  // 跨星系段：FTL 距离按恒星坐标线性缩放。
  const ftlD = distance3d(fromStar, toStar) * (cal.ftlScale ?? 1);
  const ftlRatio = cal.ftlDistance > 0 ? ftlD / cal.ftlDistance : 1;

  // 目标天体位置取决于到达时刻：先按出发时刻估时长，再迭代一次收敛。
  let toPos = bodyPositionAt(to, departureMs);
  let stlRatio = 1;
  let orbitPredicted = fromPos?.orbitPredicted ?? false;
  for (let iter = 0; iter < 2; iter++) {
    const stlRaw = interSystemStlDistance(fromPos, toPos, fromStar, toStar);
    const stlD =
      stlRaw !== undefined && cal.stlScale !== undefined ? stlRaw * cal.stlScale : stlRaw;
    stlRatio = stlD !== undefined && cal.stlDistance > 0 ? stlD / cal.stlDistance : 1;
    orbitPredicted = (fromPos?.orbitPredicted ?? false) || (toPos?.orbitPredicted ?? false);
    const durationMs = cal.stlMs * Math.sqrt(stlRatio) + (cal.chargeMs + cal.jumpMs) * ftlRatio;
    toPos = bodyPositionAt(to, departureMs + durationMs);
  }

  // 充能与跃迁时长均按 FTL 距离线性缩放（速度恒定，时间 ∝ 距离）。
  const stlScale = Math.sqrt(stlRatio);
  return {
    from,
    to,
    precise: false,
    orbitPredicted,
    durationMs: cal.stlMs * stlScale + (cal.chargeMs + cal.jumpMs) * ftlRatio,
    stlFuel: cal.stlFuel * stlScale,
    ftlFuel: cal.ftlFuel * ftlRatio,
    damage: cal.damageStl * stlScale + cal.damageFtl * ftlRatio,
  };
}
