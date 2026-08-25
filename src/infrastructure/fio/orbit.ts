import { ref } from 'vue';
import { starsStore } from '@src/infrastructure/prun-api/data/stars';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import {
  gameClockOffsetMs,
  systemBodiesStore,
  BodyObservation,
} from '@src/infrastructure/prun-api/data/system-bodies';

// FIO 轨道数据 + 开普勒位置预测。
//
// 数据源（均公开 GET，无需认证）：
// - /planet/{PlanetId}：轨道根数（半长轴 m、偏心率、倾角、升交点赤经、近拱点）
// - /systemstars/star/{StarId}：恒星质量 kg
// - /global/simulationdata：PlanetaryMotionFactor（行星运动加速倍率，实测 20）
//
// FIO 不下发轨道相位（历元），用游戏内观测标定：SFC 飞行计划 transferEllipse
// 的位置带出发/到达时间戳（system-bodies 记录），由观测方向反解真近点角 →
// 平近点角零点 M0，半径比反解米→位置单位缩放系数。
//
// 帧一致性风险：transferEllipse 坐标与恒星坐标若不在同一坐标系，标定结果
// 无意义。防线：① 同星系多天体的缩放系数必须一致（偏离 >2 倍拒绝）；
// ② 同天体两次以上观测互相回验（误差 >25% 轨道半径拒绝）。任一失败即
// 降级为静态位置（调用方处理）。

interface PlanetOrbit {
  semiMajorAxis: number; // m
  eccentricity: number;
  inclination: number; // rad
  rightAscension: number; // rad
  periapsis: number; // rad
  mass: number; // kg（天体自身质量，作为卫星轨道中心时使用）
}

interface StarInfo {
  mass: number; // kg
}

const G = 6.674e-11;
const DEFAULT_MOTION_FACTOR = 20;
const CACHE_KEY = 'rprun.fio.orbit.v1';
const VALIDATION_RADIUS_RATIO = 0.25;
const SCALE_TOLERANCE = 2;

const orbitVersion = ref(0);
const planets = new Map<string, PlanetOrbit>();
const stars = new Map<string, StarInfo>();
let motionFactor = DEFAULT_MOTION_FACTOR;
// 星系缩放系数（位置单位/米）：同星系应一致，用于交叉验证帧一致性。
const systemScales = new Map<string, number>();
// 同步缩放系数表：天体 naturalId → 星系 naturalId。
const bodySystem = new Map<string, string>();
// 星系坐标与 transferEllipse 坐标是否判定为不一致（拒绝全部预测）。
const unreliableSystems = new Set<string>();
// 天体级拒绝（观测回验失败等）。
const unreliableBodies = new Set<string>();

const inflight = new Map<string, Promise<void>>();

export const orbitStore = {
  get version() {
    return orbitVersion.value;
  },
  isReliable(naturalId?: string | null) {
    void orbitVersion.value;
    if (!naturalId) {
      return false;
    }
    const key = naturalId.toUpperCase();
    if (unreliableBodies.has(key)) {
      return false;
    }
    const system = bodySystem.get(key);
    return system === undefined || !unreliableSystems.has(system);
  },
};

function persist() {
  const data = {
    motionFactor,
    planets: Object.fromEntries(planets),
    stars: Object.fromEntries(stars),
  };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // localStorage 不可用（隐私模式等）：仅内存缓存。
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw) as {
      motionFactor?: number;
      planets?: Record<string, PlanetOrbit>;
      stars?: Record<string, StarInfo>;
    };
    if (data.motionFactor !== undefined) {
      motionFactor = data.motionFactor;
    }
    for (const [id, orbit] of Object.entries(data.planets ?? {})) {
      planets.set(id.toUpperCase(), orbit);
    }
    for (const [id, star] of Object.entries(data.stars ?? {})) {
      stars.set(id.toUpperCase(), star);
    }
  } catch {
    // 缓存损坏：忽略，用网络数据重建。
  }
}
restore();

async function fetchJson<T>(url: string): Promise<T | undefined> {
  const response = await fetch(url);
  if (!response.ok) {
    return undefined;
  }
  return (await response.json()) as T;
}

interface FioPlanet {
  OrbitSemiMajorAxis?: number;
  OrbitEccentricity?: number;
  OrbitInclination?: number;
  OrbitRightAscension?: number;
  OrbitPeriapsis?: number;
  Mass?: number;
}

interface FioStar {
  Mass?: number;
}

async function fetchPlanet(naturalId: string) {
  const key = naturalId.toUpperCase();
  const data = await fetchJson<FioPlanet>(
    `https://rest.fnar.net/planet/${encodeURIComponent(key)}`,
  );
  if (
    data === undefined ||
    data.OrbitSemiMajorAxis === undefined ||
    data.OrbitSemiMajorAxis <= 0 ||
    data.Mass === undefined
  ) {
    return;
  }
  planets.set(key, {
    semiMajorAxis: data.OrbitSemiMajorAxis,
    eccentricity: data.OrbitEccentricity ?? 0,
    inclination: data.OrbitInclination ?? 0,
    rightAscension: data.OrbitRightAscension ?? 0,
    periapsis: data.OrbitPeriapsis ?? 0,
    mass: data.Mass,
  });
  orbitVersion.value++;
}

async function fetchStar(starNaturalId: string) {
  const key = starNaturalId.toUpperCase();
  const data = await fetchJson<FioStar>(
    `https://rest.fnar.net/systemstars/star/${encodeURIComponent(key)}`,
  );
  if (data === undefined || data.Mass === undefined || data.Mass <= 0) {
    return;
  }
  stars.set(key, { mass: data.Mass });
  orbitVersion.value++;
}

async function fetchMotionFactor() {
  const data = await fetchJson<{ PlanetaryMotionFactor?: number }>(
    'https://rest.fnar.net/global/simulationdata',
  );
  if (data?.PlanetaryMotionFactor !== undefined && data.PlanetaryMotionFactor > 0) {
    motionFactor = data.PlanetaryMotionFactor;
    orbitVersion.value++;
  }
}

// 解析天体的中心天体：行星 → 恒星；卫星（如 VH-331gb）→ 母行星。
// PrUn 行星/卫星 naturalId 以小写字母结尾（VH-331g、VH-331gb），恒星系
// naturalId 以数字结尾，空间站全大写——剥一个结尾小写字母即可得中心天体。
function resolveParent(naturalId: string): { id: string; isStar: boolean } | undefined {
  const key = naturalId.toUpperCase();
  const stripped = naturalId.replace(/[a-z]$/, '').toUpperCase();
  if (stripped === key) {
    return undefined;
  }
  if (starsStore.getByNaturalId(stripped) !== undefined) {
    return { id: stripped, isStar: true };
  }
  // 剥一层后是行星 → 原 id 是其卫星。
  if (planetsStore.getByNaturalId(stripped) !== undefined) {
    return { id: stripped, isStar: false };
  }
  return undefined;
}

function ensureFetched(naturalId: string, task: () => Promise<void>) {
  const key = naturalId.toUpperCase();
  let promise = inflight.get(key);
  if (!promise) {
    promise = task().finally(() => inflight.delete(key));
    inflight.set(key, promise);
  }
  return promise;
}

// 预取一组天体（含卫星的母行星、行星的恒星）的轨道数据。容错：任一失败
// 不抛异常，仅该天体无预测。
export async function ensureOrbitData(naturalIds: string[]) {
  await fetchMotionFactor();
  await Promise.all(
    naturalIds.map(async naturalId => {
      const key = naturalId.toUpperCase();
      const parent = resolveParent(key);
      const tasks: Promise<unknown>[] = [];
      if (parent?.isStar) {
        if (!stars.has(parent.id)) {
          tasks.push(ensureFetched(parent.id, () => fetchStar(parent.id)));
        }
        bodySystem.set(key, parent.id);
      } else if (parent !== undefined && !planets.has(parent.id)) {
        // 卫星：还需母行星的轨道数据（中心位置与质量）。
        tasks.push(ensureFetched(parent.id, () => fetchPlanet(parent.id)));
      }
      if (!planets.has(key)) {
        tasks.push(ensureFetched(key, () => fetchPlanet(key)));
      }
      await Promise.all(tasks);
    }),
  );
  persist();
}

// ---- 开普勒数学 ----

function orbitalPeriodMs(semiMajorAxisM: number, centralMassKg: number) {
  const seconds =
    (2 * Math.PI * Math.sqrt(semiMajorAxisM ** 3 / (G * centralMassKg))) / motionFactor;
  return seconds * 1000;
}

// 牛顿迭代解开普勒方程 M = E - e·sin(E)。
function solveKepler(meanAnomaly: number, e: number) {
  const M = meanAnomaly % (2 * Math.PI);
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 16; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-10) {
      break;
    }
  }
  return E;
}

function trueAnomalyFromEccentric(E: number, e: number) {
  return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
}

function eccentricFromTrueAnomaly(nu: number, e: number) {
  return 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
}

// 轨道平面 → 世界坐标的旋转（Ω 升交点赤经、i 倾角、ω 近拱点）。
function orbitalToWorld(
  p: { x: number; y: number; z: number },
  orbit: PlanetOrbit,
): PrunApi.Position {
  const { inclination: i, rightAscension: o, periapsis: w } = orbit;
  const cosO = Math.cos(o);
  const sinO = Math.sin(o);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const x = cosW * p.x - sinW * p.y;
  const y = sinW * p.x + cosW * p.y;
  return {
    x: cosO * x - sinO * cosI * y,
    y: sinO * x + cosO * cosI * y,
    z: sinI * y,
  };
}

// 世界方向 → 轨道平面方向（逆旋转：Rz(-w)·Rx(-i)·Rz(-o)）。
function worldToOrbital(d: PrunApi.Position, orbit: PlanetOrbit): PrunApi.Position {
  const { inclination: i, rightAscension: o, periapsis: w } = orbit;
  const cosO = Math.cos(o);
  const sinO = Math.sin(o);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const x1 = cosO * d.x + sinO * d.y;
  const y1 = -sinO * d.x + cosO * d.y;
  const y2 = cosI * y1 + sinI * d.z;
  const z2 = -sinI * y1 + cosI * d.z;
  return {
    x: cosW * x1 + sinW * y2,
    y: -sinW * x1 + cosW * y2,
    z: z2,
  };
}

// ---- 相位标定与预测 ----

interface Phase {
  // 历元 0 时刻的平近点角。
  M0: number;
  // 平均角速度（rad/ms）。
  n: number;
  // 位置单位/米（轨道半径换算）。
  scale: number;
}

function centralBodyPosition(parentId: string, isStar: boolean, timestampMs: number) {
  if (isStar) {
    void orbitVersion.value;
    return starsStore.getByNaturalId(parentId)?.position;
  }
  return predictPosition(parentId, timestampMs);
}

function calibratePhase(
  orbit: PlanetOrbit,
  centralMassKg: number,
  centerAtObs: PrunApi.Position,
  obs: BodyObservation,
): Phase | undefined {
  const offsetX = obs.position.x - centerAtObs.x;
  const offsetY = obs.position.y - centerAtObs.y;
  const offsetZ = obs.position.z - centerAtObs.z;
  const offsetLength = Math.hypot(offsetX, offsetY, offsetZ);
  if (!Number.isFinite(offsetLength) || offsetLength <= 0) {
    return undefined;
  }

  const e = orbit.eccentricity;
  const dir = worldToOrbital(
    { x: offsetX / offsetLength, y: offsetY / offsetLength, z: offsetZ / offsetLength },
    orbit,
  );
  if (Math.abs(dir.z) > 0.05) {
    // 观测方向明显偏离轨道面 → 帧或根数不一致。
    return undefined;
  }
  const nu = Math.atan2(dir.y, dir.x);
  const E = eccentricFromTrueAnomaly(nu, e);
  const M = E - e * Math.sin(E);
  const radiusM = orbit.semiMajorAxis * (1 - e * Math.cos(E));
  if (radiusM <= 0) {
    return undefined;
  }
  const scale = offsetLength / radiusM;
  if (!Number.isFinite(scale) || scale <= 0) {
    return undefined;
  }

  const periodMs = orbitalPeriodMs(orbit.semiMajorAxis, centralMassKg);
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return undefined;
  }
  const n = (2 * Math.PI) / periodMs;
  return { M0: M - n * obs.timestampMs, n, scale };
}

function predictWithPhase(
  orbit: PlanetOrbit,
  phase: Phase,
  center: PrunApi.Position,
  timestampMs: number,
): PrunApi.Position {
  const e = orbit.eccentricity;
  const E = solveKepler(phase.M0 + phase.n * timestampMs, e);
  const nu = trueAnomalyFromEccentric(E, e);
  const radiusM = orbit.semiMajorAxis * (1 - e * Math.cos(E));
  const r = radiusM * phase.scale;
  const offset = orbitalToWorld({ x: r * Math.cos(nu), y: r * Math.sin(nu), z: 0 }, orbit);
  return {
    x: center.x + offset.x,
    y: center.y + offset.y,
    z: center.z + offset.z,
  };
}

// 预测天体在指定游戏世界时刻的位置。任何环节缺失/校验失败返回 undefined，
// 调用方降级为最近静态观测。
export function predictPosition(
  naturalId: string,
  timestampMs: number,
): PrunApi.Position | undefined {
  void orbitVersion.value;
  void systemBodiesStore.count; // 建立对观测数据的响应式依赖。

  const key = naturalId.toUpperCase();
  if (!orbitStore.isReliable(key)) {
    return undefined;
  }
  const orbit = planets.get(key);
  if (orbit === undefined) {
    return undefined;
  }
  const parent = resolveParent(key);
  if (parent === undefined) {
    return undefined;
  }
  const parentMass = parent.isStar ? stars.get(parent.id)?.mass : planets.get(parent.id)?.mass;
  if (parentMass === undefined || parentMass <= 0) {
    return undefined;
  }

  const observations = systemBodiesStore.getObservations(key);
  const latest = observations.at(-1);
  if (latest === undefined) {
    return undefined;
  }
  const centerAtObs = centralBodyPosition(parent.id, parent.isStar, latest.timestampMs);
  if (centerAtObs === undefined) {
    return undefined;
  }
  const phase = calibratePhase(orbit, parentMass, centerAtObs, latest);
  if (phase === undefined) {
    unreliableBodies.add(key);
    return undefined;
  }

  // 帧一致性：同星系缩放系数必须一致（位置单位/米）。
  const systemKey = bodySystem.get(key);
  if (systemKey !== undefined) {
    const reference = systemScales.get(systemKey);
    if (reference === undefined) {
      systemScales.set(systemKey, phase.scale);
    } else if (
      phase.scale > reference * SCALE_TOLERANCE ||
      phase.scale < reference / SCALE_TOLERANCE
    ) {
      unreliableSystems.add(systemKey);
      return undefined;
    }
  }

  // 观测回验：用较早的观测验证预测精度。
  if (observations.length >= 2) {
    const earlier = observations[observations.length - 2];
    const centerEarlier = centralBodyPosition(parent.id, parent.isStar, earlier.timestampMs);
    if (centerEarlier !== undefined) {
      const predicted = predictWithPhase(orbit, phase, centerEarlier, earlier.timestampMs);
      const radius = orbit.semiMajorAxis * phase.scale;
      const error = Math.hypot(
        predicted.x - earlier.position.x,
        predicted.y - earlier.position.y,
        predicted.z - earlier.position.z,
      );
      if (error > radius * VALIDATION_RADIUS_RATIO) {
        unreliableBodies.add(key);
        return undefined;
      }
    }
  }

  const center = centralBodyPosition(parent.id, parent.isStar, timestampMs);
  if (center === undefined) {
    return undefined;
  }
  return predictWithPhase(orbit, phase, center, timestampMs);
}

// 当前游戏世界时刻（本地时钟 + 偏差，偏差由飞行计划标定）。
export function gameNow() {
  return Date.now() + gameClockOffsetMs.value;
}
