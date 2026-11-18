export interface PlanetOrbit {
  semiMajorAxis: number; // m
  eccentricity: number;
  inclination: number; // rad
  rightAscension: number; // rad
  periapsis: number; // rad
  mass: number; // kg（天体自身质量，作为卫星轨道中心时使用）
}

// 游戏轨道模型（从游戏 bundle 逆向 + 日志观测验证）：
// - M0 = 0：所有天体在世界时间 0 时平近点角为 0。
// - worldTime = GAME_REF + (t_s - GAME_REF) * GAME_MOTION_FACTOR。
// - M = n * worldTime，n = √(G*M_center / a³)，G = 6.67384e-11。
// - 输出：轨道面 → R3(-Ω)·R1(-i)·R3(-ω) → /1e3（米→千米）+ x/y 交换，
//   与服务器 transferEllipse 坐标同一坐标系（日志观测验证误差 <1%）。
const GAME_G = 6.67384e-11;
const GAME_REF = 1451690603; // 游戏世界时间参考历元（Unix 秒）

export function gameCircularOrbitSpeedKmS(
  orbit: PlanetOrbit,
  totalMassKg: number,
  motionFactor: number,
  simulationIntervalS: number,
) {
  return (
    (Math.sqrt((GAME_G * totalMassKg) / orbit.semiMajorAxis) *
      motionFactor *
      (simulationIntervalS / 86400)) /
    1000
  );
}

export function gameOrbitalSpeedKmS(
  orbit: PlanetOrbit,
  totalMassKg: number,
  timestampMs: number,
  motionFactor: number,
  simulationIntervalS: number,
) {
  const { x, y, z } = predictWithGameModel(
    orbit,
    totalMassKg,
    timestampMs,
    motionFactor,
    simulationIntervalS,
  );
  const radiusM = Math.hypot(x, y, z) * 1000;
  const speedMps = Math.sqrt(GAME_G * totalMassKg * (2 / radiusM - 1 / orbit.semiMajorAxis));
  return (speedMps * motionFactor * (simulationIntervalS / 86400)) / 1000;
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

// 游戏 forward 旋转（轨道面 → 世界）：R3(-per)·R1(+inc)·R3(-ra)。
// 注意：旧 FTC 的 orbitalToWorld 用了正角（等价逆旋转），方向与游戏相反，是旧相位
// 标定不准的根源。
// inclination 的正负号由 BTF 样本（起飞时刻戳）验证：需**正向**旋转 R1(+i)，否则 z 分量
// 符号相反（反推恒星位置误差 5~10M km，翻转后 <1.7M）。FIO 与 DATA_DATA 的 inclination
// 约定一致（可为负），配合 R1(+i) 后与服务器坐标完全对齐。
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
  v = rotX(v, i);
  return rotZ(v, -o);
}

// ---- 游戏轨道模型预测 ----

// 用游戏同款公式预测天体在指定游戏世界时刻的位置（相对其轨道中心，千米）。
// 依赖：轨道根数 + 中心天体质量。与服务器 transferEllipse 坐标同一坐标系，
// 无需观测标定即可全量离线预测。
export function predictWithGameModel(
  orbit: PlanetOrbit,
  parentMassKg: number,
  timestampMs: number,
  motionFactor: number,
  simulationIntervalS: number,
): PrunApi.Position {
  const t_s = timestampMs / 1000;
  const worldTime = GAME_REF + (t_s - GAME_REF) * (simulationIntervalS / 86400) * motionFactor;
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
