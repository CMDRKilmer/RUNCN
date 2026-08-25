import { ref } from 'vue';
import { starsStore } from '@src/infrastructure/prun-api/data/stars';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { getSystemLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { gameClockOffsetMs } from '@src/infrastructure/prun-api/data/system-bodies';
import { sleep } from '@src/utils/sleep';

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

const DEFAULT_MOTION_FACTOR = 20;
const CACHE_KEY = 'rprun.fio.orbit.v1';
// 游戏轨道模型（从游戏 bundle 逆向 + 日志观测验证）：
// - M0 = 0：所有天体在世界时间 0 时平近点角为 0。
// - worldTime = GAME_REF + (t_s - GAME_REF) * GAME_MOTION_FACTOR。
// - M = n * worldTime，n = √(G*M_center / a³)，G = 6.67384e-11。
// - 输出：轨道面 → R3(-Ω)·R1(-i)·R3(-ω) → /1e3（米→千米）+ x/y 交换，
//   与服务器 transferEllipse 坐标同一坐标系（日志观测验证误差 <1%）。
const GAME_G = 6.67384e-11;
const GAME_REF = 1451690603; // 游戏世界时间参考历元（Unix 秒）
const GAME_MOTION_FACTOR = 20; // PlanetaryMotionFactor（FIO /global/simulationdata）

const orbitVersion = ref(0);
const planets = new Map<string, PlanetOrbit>();
const stars = new Map<string, StarInfo>();
let motionFactor = DEFAULT_MOTION_FACTOR;
// 天体 → 星系 naturalId 关联（用于中心质量解析）。
const bodySystem = new Map<string, string>();

const inflight = new Map<string, Promise<void>>();

export const orbitStore = {
  get version() {
    return orbitVersion.value;
  },
  // 已持有轨道根数的行星数（FIO 预取 + DATA_DATA 被动积累）。
  get planetCount() {
    void orbitVersion.value;
    return planets.size;
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

// ---- 内置数据（离线种子） ----

// 内置 JSON 的压缩键名格式（scripts/build-planet-data.mjs / build-star-masses.mjs 生成）：
//   n=naturalId, a=semiMajorAxis, e=eccentricity, i=inclination,
//   o=rightAscension, p=periapsis, m=mass, s=systemId
interface BundledPlanet {
  n: string;
  a: number;
  e: number;
  i: number;
  o: number;
  p: number;
  m: number;
  s?: string;
}
interface BundledStar {
  n: string;
  m: number;
}

// 启动时加载内置数据作为种子：首次使用/无缓存时提供全量离线轨道与恒星质量。
// localStorage 缓存（在线积累）优先，内置仅填充缺失项。
async function loadBundledData() {
  try {
    const [planetResp, starResp] = await Promise.all([
      fetch(config.url.planetsOrbit),
      fetch(config.url.starMasses),
    ]);
    const bundledPlanets = (await planetResp.json()) as BundledPlanet[];
    for (const p of bundledPlanets) {
      const key = p.n.toUpperCase();
      if (!planets.has(key)) {
        planets.set(key, {
          semiMajorAxis: p.a,
          eccentricity: p.e,
          inclination: p.i,
          rightAscension: p.o,
          periapsis: p.p,
          mass: p.m,
        });
      }
    }
    const bundledStars = (await starResp.json()) as BundledStar[];
    for (const s of bundledStars) {
      const key = s.n.toUpperCase();
      if (!stars.has(key)) {
        stars.set(key, { mass: s.m });
      }
    }
    orbitVersion.value++;
  } catch {
    // 内置数据加载失败：忽略，靠在线数据（DATA_DATA/FIO）。
  }
}
void loadBundledData();

async function fetchJson<T>(url: string): Promise<T | undefined> {
  const response = await fetch(url);
  if (!response.ok) {
    return undefined;
  }
  return (await response.json()) as T;
}

// 带重试的 FIO 请求：网络错误/非 200 时重试，指数退避（300ms、600ms…）。
async function fetchJsonWithRetry<T>(
  url: string,
  retries = 2,
  onRetry?: (attempt: number, reason: string) => void,
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return (await response.json()) as T;
      }
      onRetry?.(attempt + 1, `HTTP ${response.status}`);
    } catch {
      onRetry?.(attempt + 1, '网络错误');
    }
    if (attempt < retries) {
      await sleep(300 * (attempt + 1));
    }
  }
  return undefined;
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

// 写入一颗行星的轨道根数（FIO 与 DATA_DATA 共用），可附带星系关联。
// semiMajorAxis 缺失/非正视为无效数据，直接忽略。
function setPlanetOrbit(
  naturalId: string,
  orbit: {
    semiMajorAxis?: number;
    eccentricity?: number;
    inclination?: number;
    rightAscension?: number;
    periapsis?: number;
  },
  mass: number,
  systemId?: string,
) {
  if (orbit.semiMajorAxis === undefined || orbit.semiMajorAxis <= 0) {
    return;
  }
  const key = naturalId.toUpperCase();
  planets.set(key, {
    semiMajorAxis: orbit.semiMajorAxis,
    eccentricity: orbit.eccentricity ?? 0,
    inclination: orbit.inclination ?? 0,
    rightAscension: orbit.rightAscension ?? 0,
    periapsis: orbit.periapsis ?? 0,
    mass,
  });
  if (systemId) {
    bodySystem.set(key, systemId.toUpperCase());
  }
  orbitVersion.value++;
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
  setPlanetOrbit(
    key,
    {
      semiMajorAxis: data.OrbitSemiMajorAxis,
      eccentricity: data.OrbitEccentricity,
      inclination: data.OrbitInclination,
      rightAscension: data.OrbitRightAscension,
      periapsis: data.OrbitPeriapsis,
    },
    data.Mass,
  );
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

// 解析天体的中心天体：行星（naturalId 为 XX-XXX + 单个小写字母，如 VH-331g）
// → 所属星系恒星；空间站（naturalId 全大写，如 HRT）→ 所属星系恒星。
// PrUn 无卫星：所有行星都直接绕恒星公转，剥一个结尾小写字母即得恒星。
function resolveParent(naturalId: string): { id: string; isStar: boolean } | undefined {
  const key = naturalId.toUpperCase();
  // 空间站：绕所属星系恒星公转（星系详情 celestialBodies 提供其轨道根数）。
  const station = stationsStore.getByNaturalId(key);
  if (station !== undefined) {
    const systemLine = getSystemLineFromAddress(station.address);
    return systemLine ? { id: systemLine.entity.naturalId, isStar: true } : undefined;
  }
  const stripped = naturalId.replace(/[a-z]$/, '').toUpperCase();
  if (stripped === key) {
    return undefined;
  }
  if (starsStore.getByNaturalId(stripped) !== undefined) {
    return { id: stripped, isStar: true };
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

// 预取一组天体（行星/空间站及其所属恒星）的轨道数据。容错：任一失败
// 不抛异常，仅该天体无预测。内置数据已覆盖全部行星轨道与恒星质量，
// 此处仅补齐在线新增/缺失项。
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

// 游戏 forward 旋转（轨道面 → 世界）：R3(-per)·R1(-inc)·R3(-ra)。
// 注意：历史 FTC 的 orbitalToWorld 用了正角（等价逆旋转），方向与游戏相反，
// 是旧相位标定不准的根源。此实现与游戏 bundle 的 _le 完全一致。
function gameOrbitalToWorld(
  p: { x: number; y: number; z: number },
  orbit: PlanetOrbit,
): PrunApi.Position {
  const { inclination: i, rightAscension: o, periapsis: w } = orbit;
  const rotZ = (v: { x: number; y: number; z: number }, th: number) => {
    const c = Math.cos(th);
    const s = Math.sin(th);
    return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
  };
  const rotX = (v: { x: number; y: number; z: number }, th: number) => {
    const c = Math.cos(th);
    const s = Math.sin(th);
    return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
  };
  let v = rotZ(p, -w);
  v = rotX(v, -i);
  return rotZ(v, -o);
}

// ---- 游戏轨道模型预测 ----

// 用游戏同款公式预测天体在指定游戏世界时刻的位置（相对其轨道中心，千米）。
// 依赖：轨道根数 + 中心天体质量。与服务器 transferEllipse 坐标同一坐标系，
// 无需观测标定即可全量离线预测。
function predictWithGameModel(
  orbit: PlanetOrbit,
  parentMassKg: number,
  timestampMs: number,
): PrunApi.Position {
  const t_s = timestampMs / 1000;
  const worldTime = GAME_REF + (t_s - GAME_REF) * GAME_MOTION_FACTOR;
  const n = Math.sqrt((GAME_G * parentMassKg) / Math.pow(orbit.semiMajorAxis, 3));
  const M = n * worldTime;
  const e = orbit.eccentricity;
  const E = solveKepler(M, e);
  const nu = trueAnomalyFromEccentric(E, e);
  const radiusM = orbit.semiMajorAxis * (1 - e * Math.cos(E));
  const offset = gameOrbitalToWorld(
    { x: radiusM * Math.cos(nu), y: radiusM * Math.sin(nu), z: 0 },
    orbit,
  );
  // 游戏输出：x/y 交换 + /1e3（米 → 千米）。
  return {
    x: offset.y / 1e3,
    y: offset.x / 1e3,
    z: offset.z / 1e3,
  };
}

// 预测天体在指定游戏世界时刻的位置（游戏轨道模型，无需观测）。
// 任何环节缺失返回 undefined，调用方降级为最近静态观测。
export function predictPosition(
  naturalId: string,
  timestampMs: number,
): PrunApi.Position | undefined {
  void orbitVersion.value;
  const key = naturalId.toUpperCase();
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
  return predictWithGameModel(orbit, parentMass, timestampMs);
}

// 当前游戏世界时刻（本地时钟 + 偏差，偏差由飞行计划标定）。
export function gameNow() {
  return Date.now() + gameClockOffsetMs.value;
}

// ---- 轨道数据被动积累与全量预取 ----

// DATA_DATA 被动积累：用户在游戏里打开星系/行星详情时，客户端自动请求
// 星系详情（含该星系所有行星轨道根数）与行星详情（含轨道根数），插件
// 监听记录——相比 FIO 逐行星请求，这是批量且零网络开销的来源。
interface DataDataSystemPlanet {
  naturalId?: string;
  orbit?: {
    semiMajorAxis?: number;
    eccentricity?: number;
    inclination?: number;
    rightAscension?: number;
    periapsis?: number;
  };
  mass?: number;
  address?: PrunApi.Address;
}

// 星系详情的 celestialBodies：空间站（绕恒星公转，含轨道根数，无 mass）。
type DataDataSystemBody = Pick<DataDataSystemPlanet, 'naturalId' | 'orbit' | 'address'>;

onApiMessage({
  DATA_DATA(data: { path?: string[]; body?: unknown }) {
    const path = data.path;
    if (!Array.isArray(path) || path.length === 0) {
      return;
    }
    if (path[0] === 'systems' && data.body !== null && typeof data.body === 'object') {
      const body = data.body as {
        naturalId?: string;
        star?: { mass?: number };
        planets?: DataDataSystemPlanet[];
        celestialBodies?: DataDataSystemBody[];
      };
      if (body.naturalId && body.star?.mass !== undefined && body.star.mass > 0) {
        stars.set(body.naturalId.toUpperCase(), { mass: body.star.mass });
        orbitVersion.value++;
      }
      for (const planet of body.planets ?? []) {
        const orbit = planet.orbit;
        if (!planet.naturalId || orbit?.semiMajorAxis === undefined || orbit.semiMajorAxis <= 0) {
          continue;
        }
        const systemId =
          getSystemLineFromAddress(planet.address)?.entity.naturalId ?? body.naturalId;
        setPlanetOrbit(planet.naturalId, orbit, planet.mass ?? 0, systemId);
      }
      // 空间站（celestialBodies）：同样绕恒星公转，含轨道根数。
      for (const spaceBody of body.celestialBodies ?? []) {
        const orbit = spaceBody.orbit;
        if (
          !spaceBody.naturalId ||
          orbit?.semiMajorAxis === undefined ||
          orbit.semiMajorAxis <= 0
        ) {
          continue;
        }
        const systemId =
          getSystemLineFromAddress(spaceBody.address)?.entity.naturalId ?? body.naturalId;
        setPlanetOrbit(spaceBody.naturalId, orbit, 0, systemId);
      }
      persist();
    } else if (path[0] === 'planets' && data.body !== null && typeof data.body === 'object') {
      const body = data.body as {
        naturalId?: string;
        data?: {
          orbit?: DataDataSystemPlanet['orbit'];
          mass?: number;
        };
      };
      const orbit = body.data?.orbit;
      if (body.naturalId && orbit?.semiMajorAxis !== undefined && orbit.semiMajorAxis > 0) {
        setPlanetOrbit(body.naturalId, orbit, body.data?.mass ?? 0);
      }
    }
  },
});

// 渐进预取全部行星轨道根数：从本地 allplanets 列表（完整 4155 行星）出发，
// 低并发逐个请求 FIO /planet/{id}，已缓存跳过。FIO 请求不稳定且量大，
// 适合后台挂着跑（FTC 面板手动触发），期间不影响其他功能。
let allPrefetch: Promise<void> | undefined;

export function prefetchAllOrbits() {
  if (allPrefetch === undefined) {
    allPrefetch = (async () => {
      const response = await fetch(config.url.allplanets);
      const list = (await response.json()) as { PlanetNaturalId?: string }[];
      const pending = list
        .map(x => x.PlanetNaturalId)
        .filter((id): id is string => id !== undefined && !planets.has(id.toUpperCase()));
      const CONCURRENCY = 10;
      let index = 0;
      const worker = async () => {
        while (index < pending.length) {
          const id = pending[index++];
          await fetchPlanet(id);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      persist();
    })().finally(() => {
      allPrefetch = undefined;
    });
  }
  return allPrefetch;
}

// ---- 全量行星参数导出 ----

// FIO 完整行星参数（一次性批量拉取 + 本地导出）。
export interface FioPlanetFull {
  PlanetNaturalId: string;
  PlanetName?: string;
  SystemId?: string;
  Mass?: number;
  MassEarth?: number;
  Gravity?: number;
  Radius?: number;
  Surface?: boolean;
  Temperature?: number;
  Pressure?: number;
  Radiation?: number;
  MagneticField?: number;
  Sunlight?: number;
  Fertility?: number;
  OrbitSemiMajorAxis?: number;
  OrbitEccentricity?: number;
  OrbitInclination?: number;
  OrbitRightAscension?: number;
  OrbitPeriapsis?: number;
  OrbitIndex?: number;
  PlanetTier?: number;
  FactionCode?: string;
  FactionName?: string;
  Timestamp?: string;
}

export interface PlanetExportResult {
  data: FioPlanetFull[];
  success: number;
  failed: number;
}

let fullExport: Promise<PlanetExportResult> | undefined;

// 一次性拉取全部行星完整参数（低并发批量 FIO 请求，失败自动重试），
// 返回结果供本地导出；同时把轨道根数写入缓存（供 predictPosition）并持久化。
export function exportAllPlanetData(
  onProgress?: (done: number, total: number) => void,
  onLog?: (message: string) => void,
): Promise<PlanetExportResult> {
  if (fullExport === undefined) {
    fullExport = (async () => {
      const response = await fetch(config.url.allplanets);
      const list = (await response.json()) as { PlanetNaturalId?: string }[];
      const ids = list
        .map(x => x.PlanetNaturalId)
        .filter((id): id is string => id !== undefined && id !== '');
      onLog?.(`开始拉取全部行星参数（共 ${ids.length} 个，并发 10，失败自动重试 2 次）`);
      const results: FioPlanetFull[] = [];
      let success = 0;
      let failed = 0;
      const CONCURRENCY = 10;
      let index = 0;
      const worker = async () => {
        while (index < ids.length) {
          const id = ids[index++];
          const data = await fetchJsonWithRetry<FioPlanetFull>(
            `https://rest.fnar.net/planet/${encodeURIComponent(id.toUpperCase())}`,
            2,
            (attempt, reason) => onLog?.(`[重试 ${attempt}] ${id}：${reason}`),
          );
          if (data?.PlanetNaturalId !== undefined) {
            results.push(data);
            success++;
            // 同步更新轨道缓存（供 predictPosition 使用）。
            if (data.OrbitSemiMajorAxis !== undefined && data.OrbitSemiMajorAxis > 0) {
              setPlanetOrbit(
                data.PlanetNaturalId,
                {
                  semiMajorAxis: data.OrbitSemiMajorAxis,
                  eccentricity: data.OrbitEccentricity,
                  inclination: data.OrbitInclination,
                  rightAscension: data.OrbitRightAscension,
                  periapsis: data.OrbitPeriapsis,
                },
                data.Mass ?? 0,
              );
            }
          } else {
            failed++;
          }
          onProgress?.(index, ids.length);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      persist();
      onLog?.(`完成：成功 ${success} 个，失败 ${failed} 个`);
      return { data: results, success, failed };
    })().finally(() => {
      fullExport = undefined;
    });
  }
  return fullExport;
}
