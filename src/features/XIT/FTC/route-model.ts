import { starsStore, getStarNaturalId } from '@src/infrastructure/prun-api/data/stars';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { systemBodiesStore } from '@src/infrastructure/prun-api/data/system-bodies';
import { getSystemLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';

// 多段路线估算模型。
// 首段（飞船当前位置 → 第一个航点）由 SFC 查询获得服务器精确结果，
// 其余段用恒星星系坐标 + 天体位置（飞行计划 transferEllipse 捕获）外推：
// - FTL 充能时间按距离线性缩放，跃迁时间视为固定值
// - STL 时间按 sqrt(距离比) 缩放（匀加速转移轨道的一阶近似）
// - 燃料/损伤按对应距离线性缩放
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
  // 位置坐标 → 游戏 STL 距离单位的换算系数（无法标定时为 undefined）。
  stlScale?: number;
  // 位置坐标 → 游戏 FTL 距离单位的换算系数（无法标定时为 undefined）。
  ftlScale?: number;
}

export interface RouteLeg {
  from: string;
  to: string;
  precise: boolean;
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
  let damage = 0;
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
    damage += segment.damage;

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
    damage,
    stlScale,
    ftlScale,
  };
}

// 同星系内两航点间的 STL 距离（需要天体位置数据；探测失败则无）。
function intraSystemStlDistance(fromId: string, toId: string) {
  const from = systemBodiesStore.getPosition(fromId);
  const to = systemBodiesStore.getPosition(toId);
  return from !== undefined && to !== undefined ? distance3d(from, to) : undefined;
}

// 跨星系段的 STL 距离：出发行星→本星恒星 + 目标恒星→目标行星。
// 任一侧天体位置已知即可估算；两侧都缺时返回 undefined（估算层按常数外推）。
function interSystemStlDistance(
  fromId: string,
  toId: string,
  fromSystem: string,
  toSystem: string,
) {
  const fromBody = systemBodiesStore.getPosition(fromId);
  const toBody = systemBodiesStore.getPosition(toId);
  const fromStar = getStarPosition(fromSystem);
  const toStar = getStarPosition(toSystem);
  if (!fromStar || !toStar) {
    return undefined;
  }
  const departure = fromBody !== undefined ? distance3d(fromBody, fromStar) : undefined;
  const approach = toBody !== undefined ? distance3d(toStar, toBody) : undefined;
  if (departure === undefined && approach === undefined) {
    return undefined;
  }
  return (departure ?? 0) + (approach ?? 0);
}

/**
 * 用首段标定数据估算整条路线。waypoints 为完整航点序列（含首段目的地）；
 * 首段直接使用标定数据（精确），其余段外推（precise=false）。
 */
export function estimateRoute(cal: Calibration, waypoints: string[]): RouteResult {
  const legs: RouteLeg[] = [];

  // 首段：标定数据即精确结果。
  legs.push({
    from: '(当前位置)',
    to: waypoints[0],
    precise: true,
    durationMs: cal.totalMs,
    stlFuel: cal.stlFuel,
    ftlFuel: cal.ftlFuel,
    damage: cal.damage,
  });

  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1];
    const to = waypoints[i];
    const leg = estimateLeg(cal, from, to);
    if (leg !== undefined) {
      legs.push(leg);
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

function estimateLeg(cal: Calibration, from: string, to: string): RouteLeg | undefined {
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

  if (fromSystem === toSystem) {
    // 同星系：纯 STL 段。
    const raw = intraSystemStlDistance(from, to);
    const d = raw !== undefined && cal.stlScale !== undefined ? raw * cal.stlScale : raw;
    const ratio = d !== undefined && cal.stlDistance > 0 ? d / cal.stlDistance : 1;
    const scale = Math.sqrt(ratio);
    return {
      from,
      to,
      precise: false,
      durationMs: cal.stlMs * scale,
      stlFuel: cal.stlFuel * ratio,
      ftlFuel: 0,
      damage: cal.damage * ratio,
    };
  }

  // 跨星系段。
  const ftlD = distance3d(fromStar, toStar) * (cal.ftlScale ?? 1);
  const ftlRatio = cal.ftlDistance > 0 ? ftlD / cal.ftlDistance : 1;
  const stlRaw = interSystemStlDistance(from, to, fromSystem, toSystem);
  const stlD = stlRaw !== undefined && cal.stlScale !== undefined ? stlRaw * cal.stlScale : stlRaw;
  const stlRatio = stlD !== undefined && cal.stlDistance > 0 ? stlD / cal.stlDistance : 1;
  const stlScale = Math.sqrt(stlRatio);

  // 充能时间按 FTL 距离线性缩放；跃迁时长视为固定。
  const chargeMs = cal.chargeMs * ftlRatio;
  const jumpMs = cal.jumpMs;
  const stlMs = cal.stlMs * stlScale;
  return {
    from,
    to,
    precise: false,
    durationMs: stlMs + chargeMs + jumpMs,
    stlFuel: cal.stlFuel * stlRatio,
    ftlFuel: cal.ftlFuel * ftlRatio,
    damage: (cal.damage * (stlRatio + ftlRatio)) / 2,
  };
}
