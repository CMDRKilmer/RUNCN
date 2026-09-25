// 系内航段的几何预测（XIT FLEET 环线 A1 路径，2026-09-24）。
//
// 单一职责：给一对**系内**（同星系）天体的航段，从两端天体在出发时刻的轨道位置
// 推算一条「均值圆弧」的长度，并按 stlIntraTransitSpeedKmS(质量) / 状况 算出时长。
//
// ⚠️ **不是写滑块路径**：FTC 路径（ftc-compute.computeFtcPlan / SFC 联动）仍按
// fuel-model.missingModelInputs 严格判缺、宁可不写（2026-09-23 用户拍板）。本函数
// 只服务环线预估（面板展示 + 多船时间均衡 + 到港库存预测），且必须在 UI 上显式标注。
//
// ⚠️ **「均值圆弧」是初版**：基于两端**当前位置**（不是未来时刻，避免定点迭代耦合），
// 用 (r1+r2)/2 × Δθ 近似弧长；待 prun-log.json TRANSIT 段样本到位后用真实椭圆弧长
// 重新标定（数据契约见下方「椭圆契约」）。
//
// ⚠️ **hours 仅含 TRANSIT 段**：系内航线的真实段结构是单段「转移」（TRANSIT），
// 没有 DEPARTURE/APPROACH（见 fuel-model.ts 系内转移段标定块与 feature-patterns.md
// 「系内「转移」段几何 + 燃料口径标定」条目），不需要再加离港/进近段速度式。

import { predictPosition } from '@src/infrastructure/fio/orbit';
import { systemBodiesStore } from '@src/infrastructure/prun-api/data/system-bodies';
import { getStarPosition, distance3d } from './route-model';
import { stlIntraTransitSpeedKmS } from './fuel-model';

export interface TransferGeometryInputs {
  // 出发天体 naturalId。直接传入原值即可 —— 内部 store / 预测函数会自行 toUpperCase。
  fromId: string;
  // 目标天体 naturalId。
  toId: string;
  // resolveSystemId 后的星系 id（恒星 naturalId，如 'VH-331'）。
  // 两端应一致；不一致时本函数返回 undefined（跨星系几何走 pc 距离 + routeRecords，
  // 不由本函数处理）。
  fromSystemId: string;
  toSystemId: string;
  // 游戏世界时间（毫秒；用 gameClockOffsetMs 校正过；可由 gameNow() 取得）。
  t0Ms: number;
  // 飞船状况因子（[0.2, 1]，>=0.8 时为 1；<0.8 时线性衰减）。由 caller 用
  // `fuel-model.conditionFactor(ship.condition)` 计算传入。
  // 本文件**不复制** conditionFactor 实现（仓库 contributing.md 禁止在 stub 里重写逻辑），
  // 同时也不 import 该函数 —— 本模块的职责是纯几何，速度常数与状况的组合由 caller 装配，
  // 避免与 fuel-model 形成循环依赖（fuel-model 也不依赖本模块）。
  cond: number;
  // 飞船当前质量（t，含装载；= shipPerformanceFor(ship).mass）。
  // ⚠️ 必须传：转移段速度**随质量下降**（`v = 27512 × (1271/质量)^0.78`）—— 2026-09-25
  // 之前本函数漏了质量项（裸常数 27,512），重船（2,140t）航段时长偏快 1.5×。
  // 这里刻意不做成 optional 默认参考质量：漏传就是回到那个 bug，宁可编译期报错。
  massT: number;
}

export interface TransferGeometryResult {
  // 弧长（km）；undefined = 几何预测失败（轨道数据缺失 / 位置无法解析）。
  distanceKm: number | undefined;
  // 整段平均速度（km/s）：stlIntraTransitSpeedKmS(质量) / cond。
  // 质量幂律的单一来源是 fuel-model.stlIntraTransitSpeedKmS（禁止在本文件展开公式）。
  speedKmS: number;
  // 时长（小时）；distanceKm === undefined 时为 undefined。
  hours: number | undefined;
  // 数据来源标注：恒为 'predicted'（本函数所有结果均从零推得，不复用任何内置数据）。
  // 留作未来真实椭圆版本的扩展点 —— 那时 'native' 表示从服务器 transferEllipse
  // 直接取 + 精确弧长，'predicted' 仍表示本公式路线。
  source: 'predicted';
}

// 系内航段的几何预测（均值圆弧初版）。
//
// 算法（来自文档「系内「转移」段：距离不是航线常数 + 提示/日志降噪」条目）：
//   1) p1/p2 = 两端天体在 t0Ms 的位置 —— 优先用最近的服务器观测（systemBodiesStore
//      缓存的 transferEllipse.startPosition/targetPosition），无观测则回退到
//      离线游戏轨道模型 predictPosition(t0Ms)。观测与预测坐标系一致（orbit.ts 同款旋转）
//      ⇒ 两者可平滑替换。系统**不**用任何「未来时刻」的位置 —— 环线面板只知道出发时刻。
//   2) starPos = 出发星系恒星位置（getStarPosition(fromSystemId)）。
//   3) r1/r2 = 两端天体到恒星的距离（distance3d）。
//   4) theta = 两端相对恒星的角距：cos(θ) = dot(p1-star, p2-star) / (r1·r2)，θ = acos(clamp(...))。
//   5) rMid = (r1 + r2) / 2；arcKm = rMid × θ（**均值圆弧**）。
//   6) speedKmS = stlIntraTransitSpeedKmS(质量) / cond；
//      hours = arcKm / (speedKmS × 3600)。
//
// 失败条件（任一 → 返回 undefined，不静默）：
//   - 跨星系调用（fromSystemId !== toSystemId）。
//   - 任一端位置缺失（getPosition 回退到 predictPosition 也无值）。
//   - 恒星位置缺失（getStarPosition 返回 undefined）。
//   - 任一距离 NaN 或 ≤ 0（轨道根数缺失或半长轴为 0）。
//   - cosTheta 经 clamp 后算 acos 不在 [0, π]（数值退化）。
//
// 📌 **椭圆契约（占位，本轮未实现，注释必写）**：
//   TransferEllipse = { startPosition, targetPosition, center, alpha,
//                      semiMajorAxis, semiMinorAxis }
//   真实椭圆自带 arc-length 精确解（数值积分或椭圆弧长公式）。当前
//   `system-bodies.recordFromFlightPlan:105-126` 只读 startPosition/targetPosition，
//   丢了 center/alpha/semiMajorAxis/semiMinorAxis 四个分量 ⇒ 暂时拿不到精确弧长。
//   recordFromFlightPlan 扩字段后，本函数可一键切换到精确版本：
//   speedKmS / hours / source 字段不变（仍 'predicted'），只改 distanceKm 的计算路径。
//
// 📌 **偏差量级（用户实测 BTF 数据，data/ftc-calibration/btf-scan-2026-09-24.json）**：
//   - 同航线同船同 f 的点间距离漂移 ≤ 0.4%（HRT→VH-331g 报 520,267,630 → 522,220,425 km）；
//   - 时长口径与 computeFuelOption 同源（同一个 stlIntraTransitSpeedKmS）：
//     BTF 样本质量 1,271t → 27,512 km/s，用户重船样本 2,727t → 15,168 km/s（实测 15,186，+0.12%）；
//   - 待更长距离/更多引擎的 BTF 采样后重新标定（advanced/glass/hyperthrust 未实测）。
export async function predictTransferGeometry(
  inputs: TransferGeometryInputs,
): Promise<TransferGeometryResult | undefined> {
  const { fromId, toId, fromSystemId, toSystemId, t0Ms, cond, massT } = inputs;

  // 跨星系不是本函数的职责（pc 距离 + routeRecords 已有专门路径）。
  if (fromSystemId !== toSystemId) {
    return undefined;
  }

  // 两端位置：优先用最近的服务器观测（system-bodies 缓存来自过去飞行计划
  // transferEllipse.startPosition/targetPosition），无观测则用 predictPosition(t0Ms)。
  const p1 = systemBodiesStore.getPosition(fromId) ?? predictPosition(fromId, t0Ms);
  const p2 = systemBodiesStore.getPosition(toId) ?? predictPosition(toId, t0Ms);
  const starPos = getStarPosition(fromSystemId);
  if (p1 === undefined || p2 === undefined || starPos === undefined) {
    return undefined;
  }

  // r1, r2 = 两端天体到恒星的距离（km）。
  const r1 = distance3d(p1, starPos);
  const r2 = distance3d(p2, starPos);
  if (!Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0 || r2 <= 0) {
    return undefined;
  }

  // theta = 两端相对恒星的角距（rad）。
  const dx1 = p1.x - starPos.x;
  const dy1 = p1.y - starPos.y;
  const dz1 = p1.z - starPos.z;
  const dx2 = p2.x - starPos.x;
  const dy2 = p2.y - starPos.y;
  const dz2 = p2.z - starPos.z;
  const dot = dx1 * dx2 + dy1 * dy2 + dz1 * dz2;
  const cosTheta = dot / (r1 * r2);
  // acos 输入必须 clamp 到 [-1, 1]（浮点误差可能让 dot/(r1·r2) 越界）。
  const clamped = Math.min(1, Math.max(-1, cosTheta));
  if (!Number.isFinite(clamped)) {
    return undefined;
  }
  const theta = Math.acos(clamped);
  if (!Number.isFinite(theta) || theta <= 0) {
    return undefined;
  }

  // 均值圆弧：r_mid × Δθ（**初版**，待 prun-log.json TRANSIT 段样本到位后用真实
  // 椭圆弧长替换；见文件头「椭圆契约」）。
  const rMid = (r1 + r2) / 2;
  const arcKm = rMid * theta;
  if (!Number.isFinite(arcKm) || arcKm <= 0) {
    return undefined;
  }

  // 整段平均速度（km/s）：stlIntraTransitSpeedKmS(质量) / cond
  // —— 公式只在 fuel-model 里写一次（2026-09-25 之前本文件用裸常数 27,512 计时，
  // 漏了质量幂律项，与 computeFuelOption 的口径漂移，重船时长偏快）。
  const speedKmS = stlIntraTransitSpeedKmS(massT) / cond;

  // 时长（小时）：d / (v × 3600)。
  const hours = arcKm / (speedKmS * 3600);

  return {
    distanceKm: arcKm,
    speedKmS,
    hours,
    source: 'predicted',
  };
}
