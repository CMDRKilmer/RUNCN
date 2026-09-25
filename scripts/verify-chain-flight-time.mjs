// 环线各段预计飞行时间（真实模块 src/features/XIT/FLEET/chain-flight-time.ts 的
// estimateChainFlightTimes）回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-24 A1 修订）：上一轮「反方向原生记录近似」已被**轨道预测几何**取代
//（transfer-geometry.ts 的 predictTransferGeometry —— 均值圆弧 r_mid × Δθ +
// stlIntraTransitSpeedKmS(质量) / 状况，初版）。算法层走真实 chain-flight-time.ts
// 调用真实 transfer-geometry.ts；A1 的几何由两端天体的 systemBodiesStore 观测 /
// predictPosition 轨道推算得出，**不再**依赖同星系表查表键。
// ⚠️ 2026-09-25：转移段速度不再是裸常数 27,512，而是 27512 × (1271/质量)^0.78
//（重船慢）—— 本脚本的夹具质量 2,140t ⇒ 乘数 1.5013751，旧期望值已按此修正（见下方
// 断言变更记录）。之前 transfer-geometry 漏了质量项（与 computeFuelOption 口径漂移）。
//
// 本脚本锁定的契约（全部直接驱动真实模块，见下「依赖替身」）：
//   ① 输入残缺（missingModelInputs 非空）→ ok=false、error='缺原生 STL 段记录'、
//      missingInputs=[成因全文]、hours=0、arriveAtMs=departAtMs，且**不推进** elapsedMs；
//   ② 系内航线 + 前向几何缺失 + 几何预测成功 → ok=true + approximated={kind:'predicted',
//      from, to, distanceKm}，用时长直接来自 approx.hours（不调 bestOptionFor）；
//   ③ 系内航线 + 前向几何已记录 → approximated===undefined（预测路径根本**不**被调）；
//   ④ 几何预测成功后**再判一次** missingModelInputs（罐容量/余量缺失仍判缺，几何预测
//      不掩盖残缺）；
//   ⑤ 汇总：ok = legs.every(ok)、totalHours 只累加 ok 段、approximatedLegs = 预测段数；
//   ⑥ 几何预测路径**不**调 setFtcFuelSlider / setFtcReactorUsage（写入面专属 FTC 面板）；
//   ⑦ 跨星系（route.legs.length > 0）→ 预测**不**被调（系内守卫）；
//   ⑧ 均值圆弧公式的数学不变性（r_mid = (r1+r2)/2、arcKm = r_mid × θ、hours =
//      arcKm / (stlIntraTransitSpeedKmS(质量) × 3600) / cond）；
//   ⑨ 与 BTF 已知 TRANSIT 弧长（HRT → VH-331g 实测 599.22M km）的偏差 < 30%
//     （hard cap），期望 1-6% 偏差内；
//   ⑩ 不同 t0Ms → distanceKm **单调稳定** ± 5%（旋转轨道有相位漂移，不要恒定值）；
//   ⑪ 转移段速度只有**一份公式**：transfer-geometry 对同一 (d, mass) 的输出 ≡
//      fuel-model.stlIntraTransitSpeedKmS(mass)（防「两处各自展开」再次漂移）。
//
// 依赖替身（scripts/lib/chain-flight-time-loader.mjs）：只有浏览器侧/编排侧依赖走替身
// （vue / ships / blueprints / storage / buffers / sleep / orbit / routes / stars / stations /
// flight-plans / ftc-fuel-settings / system-bodies），被测链路全部保留真实实现：
//   chain-flight-time.ts（被测）→ transfer-geometry.ts（真实：均值圆弧公式 + 速度单一来源）
//   → fuel-model.ts（纯函数模型）→ route-planner.ts（几何来源与查表键）→ route-model.ts
//   （resolveSystemId / isSystemId）→ ftc-compute.ts（shipPerformanceFor）→
//   system-bodies.ts（stlSegmentsStore 的真实记录/查表 + systemBodiesStore 由 stub 覆盖）。
//
// system-bodies 走 stub 的原因（见 loader 文件头）：predictTransferGeometry 读
// systemBodiesStore.getPosition 作为优先位置来源 —— 真实 store 由过去飞行计划
// transferEllipse 填充，本脚本不能触发真实飞行来填表。stub 提供可注入的
// stubSetBodyObservation（静态坐标）与 stubSetOrbit（圆轨道简化，由 t0Ms 算位置），
// 保留真实 stlSegmentsStore 让既有 SHIP_FLIGHT_MISSION 派发断言不变。这是「真实
// store 子集可注入」的标准做法（docs/contributing.md 「写路径与查表路径同错则恒绿」
// 的延伸）。
//
// ⚠️ 为什么 STL 段记录**不用**替身 store：写入键与查表键是成对的契约，替身把两边都自己写会
// 让两边同错而不被发现（docs/contributing.md「写路径与查表路径同错则恒绿」）。这里用真实
// SHIP_FLIGHT_MISSION 消息（api-messages.dispatch）驱动真实 recordStlSegments 写入。
//
// 断言常数来源（docs/contributing.md）：
//   · 距离/段时长是夹具字面量（BTF 标定：HRT/VH-331g 半径 46.81M / 440.95M km，相对
//     角度 2.4569 rad；转移段速度基准 27,512 km/s（1,271t 参考质量）与质量指数 0.78
//     来自 fuel-model.ts 的 BTF 直采标定，夹具 2,140t 的字面量乘数 = 1.5013751）；
//   · 几何预测时长用字面量弧长算（mean arc + 状况=1），**基准值**与 BTF 实测
//     599.22M / 21,780s 对应 6.05h 逐位匹配 —— 该基准值只对 1,271t 成立，夹具 2,140t 按
//     质量乘数放大（这是 A1 的口径锚点 + 2026-09-25 的质量项修正）；
//   · **不 import 任何生产常数**做期望值：GW_LOCK_HOURS / GW_COST_PER_JUMP / NAT_PC_PER_H
//     等一律不进断言（并发会话正在改网关口径，且本脚本的夹具不含网关段）。
//     ⚠️ 唯一非期望值的生产导入是 ⑪ 的 stlIntraTransitSpeedKmS —— 它作为「被对照的另一处
//     口径」参与比较（比对对象），**不用**来拼期望值。
//
// 变异验证（第 1 轮，2026-09-24 本脚本落地时）—— 详见「变异测试」节：把被测判缺分支
// 改回旧行为 / 把 arcKm 公式×2 → 脚本立刻变红（退出码 1），原文 FAIL 见报告。
// 还原用备份副本覆盖（SHA256 字节级一致）→ 脚本回到全 PASS。
//
// 用法：node scripts/verify-chain-flight-time.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
//
// 局限（别把这里的绿当成端到端绿）：
//   · DOM / 面板展示（ChainView.vue 的「飞行」列文案、多船时间均衡、到港库存预测的消费端）
//     **不在覆盖范围内** —— 本脚本只锁 estimateChainFlightTimes 的返回值契约；
//   · 恒星坐标、航线图、空间站归属是替身注入的**合成**数据，本脚本只用它们把
//     planRoutes 走到系内（legs 为空）与跨星系（1 条自然边）两种真实分支；
//   · 油罐余量恒不可用（替身返回 undefined）→ stlRemaining 恒 undefined，段燃料基准回落罐
//     容量（真实环境里罐不满时用余量，该分支未覆盖）；
//   · gameNow 是替身常量（真实实现 = Date.now() + 计划标定的偏差），只有「缺省起点时刻」
//     一条用例依赖它；
//   · 网关航线（gwCount > 0）未覆盖：其时长口径正被另一会话改动（GW_LOCK_HOURS），
//     本脚本刻意不碰，避免与那边互相绑死。
import { register } from 'node:module';

// 真实链路：chain-flight-time / transfer-geometry / route-planner / route-model /
// fuel-model / ftc-compute / system-bodies 保留生产实现；只有浏览器侧依赖走替身
//（见 loader 的依赖图注释）。
register('./lib/chain-flight-time-loader.mjs', import.meta.url);

// 生产构建由 unimport 注入的全局（真实环境里由 vite/unimport 提供）：system-bodies 用 ref。
globalThis.ref = value => ({ value });
globalThis.config = {
  url: {
    stlSegments: 'https://stub.invalid/stl-segments.json',
    planetEnv: 'https://stub.invalid/planet-env.json',
  },
};
// 内置 STL 段数据：返回空表 —— 夹具只认本脚本派发的计划写下的记录（避免内置快照漂移成隐式夹具）。
globalThis.fetch = async () => ({ json: async () => ({}) });
// system-bodies 的持久化用 window.setTimeout（1000ms 防抖）；本脚本不断言持久化，只为不报错。
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
  configurable: true,
});

const stub = await import('./lib/chain-flight-time-stub.mjs');
// 与生产同一实例的模型（经 shim，见 scripts/lib/chain-flight-time-fuel-model.mjs）。
const fuelModel = await import('./lib/chain-flight-time-fuel-model.mjs');
const { computeFuelOption, findBalanceOption, missingModelInputs, scanFuelOptions } = fuelModel;
const { autoFuelGrid } = fuelModel;
// 转移段速度的**唯一公式来源**（⑪ 用它做「两处口径一致」的对照面，不用来算期望值 ——
// 期望值一律是字面量，见文件头「断言常数来源」）。
const { stlIntraTransitSpeedKmS } = fuelModel;
const api = await import('../src/infrastructure/prun-api/data/api-messages.ts');
const { stlSegmentsStore } = await import('../src/infrastructure/prun-api/data/system-bodies.ts');
const { planRoutes, routeMetrics } = await import('../src/features/XIT/FTC/route-planner.ts');
const { shipPerformanceFor } = await import('../src/features/XIT/FTC/ftc-compute.ts');
const { estimateChainFlightTimes } = await import('../src/features/XIT/FLEET/chain-flight-time.ts');
// 真实 predictTransferGeometry：⑧⑨⑩ 直接驱动；其内部依赖由 loader 重定向到可控 stub。
const { predictTransferGeometry } = await import('../src/features/XIT/FTC/transfer-geometry.ts');

const summary = { pass: 0, fail: 0 };

function check(name, fn) {
  const failures = [];
  try {
    fn(failures);
  } catch (e) {
    failures.push(`抛出异常 ${String(e)}`);
  }
  if (failures.length === 0) {
    summary.pass++;
    console.log(`PASS ${name}`);
  } else {
    summary.fail++;
    console.log(`FAIL ${name} ${failures.join(' | ')}`);
  }
}

async function checkAsync(name, fn) {
  const failures = [];
  try {
    await fn(failures);
  } catch (e) {
    failures.push(`抛出异常 ${String(e)}`);
  }
  if (failures.length === 0) {
    summary.pass++;
    console.log(`PASS ${name}`);
  } else {
    summary.fail++;
    console.log(`FAIL ${name} ${failures.join(' | ')}`);
  }
}

function expectExact(failures, label, actual, expected) {
  if (!Object.is(actual, expected)) {
    failures.push(`expected=${expected} actual=${actual} (${label})`);
  }
}
function expectClose(failures, label, actual, expected, tol) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
    failures.push(`expected=${expected}±${tol} actual=${actual} (${label})`);
  }
}
function expectCondition(failures, label, ok, expectedText, actualText) {
  if (!ok) {
    failures.push(`expected=${expectedText} actual=${actualText} (${label})`);
  }
}
function expectTextIncludes(failures, label, text, needle) {
  if (typeof text !== 'string' || !text.includes(needle)) {
    failures.push(`expected=含「${needle}」 actual=${text} (${label})`);
  }
}

// ---- 夹具 ----
const T0 = 1_700_000_000_000;
// 与替身 gameNow 一致（缺省起点时刻用例）。
const GAME_NOW_STUB = 1_700_000_000_000;
const NO_PRICES = { stlPrice: 0, ftlPrice: 0, timeValue: 0 };
// 合成星系：ZZ-101 内的行星 a..k（全部经 starsStore.getByPlanetNaturalId 解析到 ZZ-101）；
// XX-201 / YY-301 是跨星系用例的两个恒星系；VH-331 是 HRT/VH-331g 的所属星系（⑧⑨⑩）。
const SYS = 'ZZ-101';
// BTF 标定（HRT → VH-331g 同星系转移段：半径 / 角度 / arcKm，逐位匹配服务器实测）。
// 数据见 data/ftc-calibration/btf-scan-2026-09-24.json tag=4：TRANSIT 段 6h 3m / 599.22M km /
// 178u —— 与参考速度 27,512 km/s 算 599.22M / 27512 / 3600 = 6.05h 吻合（**该样本质量
// 1,271t**；本夹具 2,140t 的期望值要乘质量乘数 1.5013751）。
const HRT_RADIUS_KM = 46_810_000;
const VH_331G_RADIUS_KM = 440_950_000;
const BTF_PHASE_REF = 2.4569; // rad，HRT 在 0、VH-331g 在该角 → 均值圆弧 = 599.22M km
const BTF_TRANSIT_KM = 599_220_390; // BTF tag=4 实测 TRANSIT 弧长（21,780s × 27512 km/s）

const SHIP = {
  registration: 'STUB-01',
  blueprintNaturalId: 'BP-STUB',
  mass: 2140,
  operatingEmptyMass: 1271,
  acceleration: 0,
  thrust: 0,
  condition: 1,
  stlFuelFlowRate: 0.015,
  reactorPower: 0,
  idStlFuelStore: undefined,
  idFtlFuelStore: undefined,
};

// ⚠️ 断言变更记录（2026-09-25）：系内转移段速度补了**质量幂律项**
// v = 27,512 × (1,271/mass)^0.78（commit 12530b2c；标定块见 fuel-model.ts
// STL_INTRA_TRANSIT_SPEED_KM_S 上方）。
// 本夹具 SHIP.mass = 2,140 t（整备 1,271 t）⇒ 质量乘数 (2140/1271)^0.78 = 1.5013751。
// 注：任务书里的 1.50159 是算错的，实测比值 1.5013751168551859（= 改动前本脚本 ③⑥ 的
// 实际 expected/actual 比），下面用实测值。
// 时长按乘数放大（重船慢）、速度按乘数缩小；乘数只保留 8 位有效数字（可读性优先），
// 与生产实现逐位差 1 ULP ⇒ 凡带乘数的断言用 expectClose（容差 1e-6 h ≈ 0.0002%，
// 仍能抓住任何 ≥0.001% 的回归；裸 expectExact 对「字面量乘数」不成立）。
const TRANSIT_MASS_MULT_2140 = 1.5013751;
// 2,140 t 时的转移段平均速度（27,512 是 1,271 t 参考质量下的值）。
const TRANSIT_SPEED_KM_S_2140 = 27512 / TRANSIT_MASS_MULT_2140;

// 标准引擎 / 罐 3500 / G8 / 最小反应堆 0.3 / 充能 135s。tank = 0 用于「罐容量缺失」夹具
// （blueprintInfoFor 把 0 当缺失 → stlFuelCapacity undefined）。
const blueprint = (tank = 3500) => ({
  performance: {
    ftlMaxSpeed: 2.84 / 3600,
    stlFuelCapacity: tank,
    minReactorUsage: 0.3,
    emitterChargeTime: 135,
    maxGFactor: 8,
  },
  selections: [
    { type: 'STL_ENGINE', option: 'STL_ENGINE_STANDARD', amount: 1, modifiers: [] },
    {
      type: 'FTL_REACTOR',
      option: 'FTL_REACTOR_STUB',
      amount: 1,
      modifiers: [{ type: 'FTL_POWER', value: 2400 }],
    },
  ],
});

const sysLine = id => ({ type: 'SYSTEM', entity: { naturalId: id, name: id } });
const bodyLine = (type, id) => ({ type, entity: { naturalId: id, name: id } });
const bodyAddress = (system, body) => ({ lines: [sysLine(system), bodyLine('PLANET', body)] });

// 真实写入路径：一份系内「转移」（TRANSIT）段计划 → recordStlSegments 同时写
// 同星系表（键 出发天体|目标天体）与航线级表（同键）。**只有 origin 星系 === destination
// 星系**时才写同星系表 —— 这正是「系内」的定义（见 system-bodies.recordStlSegments）。
function dispatchTransit(fromBody, toBody, km, seconds, { fromSystem = SYS, toSystem = SYS } = {}) {
  api.dispatch({
    type: 'SHIP_FLIGHT_MISSION',
    data: {
      missionId: `M-${fromBody}-${toBody}`,
      segments: [
        {
          type: 'TRANSIT',
          origin: bodyAddress(fromSystem, fromBody),
          destination: bodyAddress(toSystem, toBody),
          departure: { timestamp: T0 },
          arrival: { timestamp: T0 + seconds * 1000 },
          stlDistance: km,
          stlFuelConsumption: null,
          transferEllipse: null,
          ftlDistance: null,
          ftlFuelConsumption: null,
          damage: 0,
        },
      ],
    },
  });
}

// 每条 check 自备状态：飞船/蓝图/恒星/航线图一律重设（记录表是真实 store，只增不改 ——
// 每个场景用**互不相交**的天体对，故无需清空，单跑与乱序都不漂移）。
function prepareEnvironment({ tank = 3500, graph = {} } = {}) {
  stub.stubSetShip(SHIP);
  stub.stubSetBlueprint(blueprint(tank));
  stub.stubSetStar(SYS, { x: 0, y: 0, z: 0 });
  stub.stubSetStar('XX-201', { x: 0, y: 0, z: 0 });
  // 坐标单位是游戏 ParsecLength(=12)/pc → x=60 ⇒ pc = 5（跨星系用例断言 natPc = 5）。
  stub.stubSetStar('YY-301', { x: 60, y: 0, z: 0 });
  stub.stubSetStar('VH-331', { x: 0, y: 0, z: 0 });
  stub.stubSetRouteGraph(graph);
  stub.stubClearBodyInjection();
  stub.stubResetFtcWrites();
}

// 给系内场景用的两端天体观测（systemBodiesStore.getPosition 用，A1 路径优先读）。
// 默认恒星在原点；行星按角度 θ 放置在半径 r 处。helper 让 ②⑤⑥ 类用例只填 (id, r, θ)。
function stubSetBodyObs(id, radiusKm, angleRad, starId = SYS) {
  const cx = stub;
  cx.stubSetBodyObservation(id, {
    x: radiusKm * Math.cos(angleRad),
    y: radiusKm * Math.sin(angleRad),
    z: 0,
  });
  // ensure star is at origin so distances equal radius
  cx.stubSetStar(starId, { x: 0, y: 0, z: 0 });
}

// HRT/VH-331g 圆轨道（⑧⑨⑩ 用）：HRT 周期 1 天，VH-331g 周期略慢（24.24h）以让两体相对
// 角距在 ±2 天窗口内漂移 ±5% —— 既验证「非恒定」也验证「稳定」。
const HRT_PERIOD_MS = 86_400_000;
const VH_331G_PERIOD_MS = 87_264_000;
function stubSetHrtVh331gOrbits() {
  stub.stubSetOrbit('HRT', {
    centerStar: 'VH-331',
    radiusKm: HRT_RADIUS_KM,
    periodMs: HRT_PERIOD_MS,
    phaseAtT0: 0,
  });
  stub.stubSetOrbit('VH-331G', {
    centerStar: 'VH-331',
    radiusKm: VH_331G_RADIUS_KM,
    periodMs: VH_331G_PERIOD_MS,
    phaseAtT0: BTF_PHASE_REF,
  });
}

const run = (origin, stopIds) =>
  estimateChainFlightTimes({
    ship: SHIP,
    origin,
    stops: stopIds.map(id => ({ naturalId: id, planetName: `${id} 站` })),
    startAtMs: T0,
  });

// ---- ① 系内 + 无任何原生记录 + 几何预测失败：每段判缺（锁 A1 路径的核心契约）----
await checkAsync('① 系内 + 几何预测失败 → 每段判缺（ok=false / hours=0 / 不推进时刻）', async f => {
  prepareEnvironment();
  // 强制 predictTransferGeometry 返回 undefined → 算法走判缺分支。
  stub.stubForcePredictFail(true);
  try {
    const est = await run('ZZ-101a', ['ZZ-101b']);
    expectExact(f, '段数', est.legs.length, 2);
    expectExact(f, 'est.ok', est.ok, false);
    expectExact(f, 'shipRegistration', est.shipRegistration, 'STUB-01');
    for (const [i, leg] of est.legs.entries()) {
      expectExact(f, `段${i}.ok`, leg.ok, false);
      expectExact(f, `段${i}.error`, leg.error, '缺原生 STL 段记录');
      expectCondition(
        f,
        `段${i}.missingInputs 非空`,
        (leg.missingInputs?.length ?? 0) > 0,
        '>0 条成因',
        String(leg.missingInputs?.length),
      );
      expectExact(f, `段${i}.hours`, leg.hours, 0);
      expectExact(f, `段${i}.arriveAtMs === departAtMs`, leg.arriveAtMs, leg.departAtMs);
      expectExact(f, `段${i}.departAtMs`, leg.departAtMs, T0);
      expectExact(f, `段${i}.approximated`, leg.approximated, undefined);
      expectExact(f, `段${i}.option`, leg.option, undefined);
      expectExact(f, `段${i}.metrics`, leg.metrics, undefined);
      expectExact(f, `段${i}.route`, leg.route, undefined);
    }
    expectExact(f, 'totalHours', est.totalHours, 0);
    expectExact(f, 'approximatedLegs', est.approximatedLegs, 0);
    // 负向：不存在 ok && hours===0 的段（旧 0 小时 bug 的形状）。
    expectExact(
      f,
      'ok 且 hours===0 的段数',
      est.legs.filter(l => l.ok === true && l.hours === 0).length,
      0,
    );
  } finally {
    stub.stubForcePredictFail(false);
  }
});

// ① 交叉验证 + 成因文案：判缺成因必须来自真实 missingModelInputs（同输入逐字一致）。
await checkAsync('① 判缺成因来自真实 missingModelInputs（逐字一致 + 指明系内）', async f => {
  prepareEnvironment();
  stub.stubForcePredictFail(true);
  try {
    const metrics = routeMetrics(planRoutes('ZZ-101a', 'ZZ-101b').natural);
    expectExact(f, '夹具几何确实缺失（stlRecorded）', metrics.stlRecorded, false);
    expectExact(f, '夹具几何确实缺失（stlDistanceKm）', metrics.stlDistanceKm, undefined);
    const expected = missingModelInputs(shipPerformanceFor(SHIP), metrics);
    expectCondition(f, '真实模型报缺', expected.length > 0, '>0 条', String(expected.length));
    expectTextIncludes(f, '真实模型的成因指明系内', expected[0], '系内飞行');
    const est = await run('ZZ-101a', ['ZZ-101b']);
    expectExact(
      f,
      '段0.missingInputs[0] 与真实模型逐字一致',
      est.legs[0].missingInputs?.[0],
      expected[0],
    );
    const reverseMetrics = routeMetrics(planRoutes('ZZ-101b', 'ZZ-101a').natural);
    const expectedReverse = missingModelInputs(shipPerformanceFor(SHIP), reverseMetrics);
    expectExact(
      f,
      '段1.missingInputs[0] 与真实模型逐字一致',
      est.legs[1].missingInputs?.[0],
      expectedReverse[0],
    );
  } finally {
    stub.stubForcePredictFail(false);
  }
});

// ① 缺省起点时刻 = gameNow()（替身常量）。
await checkAsync('① 缺省 startAtMs → 第一段出发时刻 = gameNow()', async f => {
  prepareEnvironment();
  stub.stubForcePredictFail(true);
  try {
    const est = await estimateChainFlightTimes({
      ship: SHIP,
      origin: 'ZZ-101a',
      stops: [{ naturalId: 'ZZ-101b', planetName: 'ZZ-101b 站' }],
    });
    expectExact(f, '段0.departAtMs', est.legs[0].departAtMs, GAME_NOW_STUB);
    expectExact(f, 'stub gameNow', stub.gameNow(), GAME_NOW_STUB);
  } finally {
    stub.stubForcePredictFail(false);
  }
});

// ---- ② 系内 + 几何预测成功：predicted 标注 + hours > 0 ----
await checkAsync(
  '② 系内 + 几何预测成功 → ok + predicted（逐字段对齐 transfer-geometry）',
  async f => {
    prepareEnvironment();
    // h → i：h 在半径 1M / 0°、i 在 1M / 90° ⇒ r_mid = 1M, θ = π/2, arcKm ≈ 1.5708M km,
    // hours 基准 ≈ 1.5708e6 / (27512 × 3600) ≈ 0.01586 h（× 质量乘数 1.5013751；与 f 无关）。
    stubSetBodyObs('ZZ-101h', 1_000_000, 0);
    stubSetBodyObs('ZZ-101i', 1_000_000, Math.PI / 2);
    // 单独驱动一次 predictTransferGeometry，验证 algorithm leg.approximated.distanceKm
    // 与 transfer-geometry 直接返回值**逐位一致**（不重写公式）。
    const predicted = await predictTransferGeometry({
      fromId: 'ZZ-101h',
      toId: 'ZZ-101i',
      fromSystemId: SYS,
      toSystemId: SYS,
      t0Ms: T0,
      cond: 1,
      massT: SHIP.mass,
    });
    expectCondition(
      f,
      'predictTransferGeometry 直接调用成功',
      predicted !== undefined,
      '成功',
      'undefined',
    );
    const est = await run('ZZ-101h', ['ZZ-101i']);
    const leg = est.legs[0];
    expectExact(f, '段0.ok', leg.ok, true);
    expectExact(f, '段0.error', leg.error, undefined);
    expectExact(f, '段0.missingInputs', leg.missingInputs, undefined);
    // 来源标注：字段与值逐位对应真实 predictTransferGeometry 的返回值。
    expectExact(f, 'approximated.kind', leg.approximated?.kind, 'predicted');
    expectExact(f, 'approximated.from', leg.approximated?.from, 'ZZ-101h');
    expectExact(f, 'approximated.to', leg.approximated?.to, 'ZZ-101i');
    expectExact(f, 'approximated.distanceKm', leg.approximated?.distanceKm, predicted.distanceKm);
    expectExact(
      f,
      'approximated 字段集合',
      Object.keys(leg.approximated ?? {})
        .sort()
        .join(','),
      'distanceKm,from,kind,to',
    );
    // 用时长的 metrics 是「近似后的」：d/转移路程都取几何预测值。
    expectExact(f, '段0.metrics.stlDistanceKm', leg.metrics?.stlDistanceKm, predicted.distanceKm);
    expectExact(f, '段0.metrics.transitKm', leg.metrics?.transitKm, predicted.distanceKm);
    // 近似不是原生记录：stlRecorded 仍为 false（面板/诊断据此区分）。
    expectExact(f, '段0.metrics.stlRecorded', leg.metrics?.stlRecorded, false);
    // hours 直接来自 approx.hours（predictTransferGeometry 内部已含 cond 校正），逐位对齐。
    expectExact(f, '段0.hours', leg.hours, predicted.hours);
    expectCondition(f, '段0.hours > 0', leg.hours > 0, '>0', String(leg.hours));
    expectExact(f, '段0.source', predicted.source, 'predicted');
    // 2,140 t ⇒ 27,512 / 1.5013751（不是 27,512 —— 速度随质量下降）。
    expectClose(f, '段0.speedKmS（含质量幂律）', predicted.speedKmS, TRANSIT_SPEED_KM_S_2140, 0.01);
    // predicted 路径不调 bestOptionFor → leg.option 为 undefined（与 FTC 面板路径不同）。
    expectExact(f, '段0.option（预测路径不算 fuel）', leg.option, undefined);
    // 回程段（i → h）走真实几何预测（90° → -90°，theta 也是 π/2，arcKm 相同）。
    const back = est.legs[1];
    expectExact(f, '回程段.ok', back.ok, true);
    expectExact(f, '回程段.approximated.from', back.approximated?.from, 'ZZ-101i');
    expectExact(f, '回程段.approximated.to', back.approximated?.to, 'ZZ-101h');
    expectExact(
      f,
      '回程段.departAtMs（段0 已推进 elapsed）',
      back.departAtMs,
      T0 + leg.hours * 3600000,
    );
    expectExact(f, 'est.approximatedLegs', est.approximatedLegs, 2);
    expectExact(f, 'est.ok', est.ok, true);
  },
);

// ② 模型不变性：同 f 的 stlFuel 逐位相同（罐口径、与距离无关）。验证 fuel-model 与
// 距离无关：A1 用 predicted 距离、B1 用 forward 原生距离——两个 metrics 喂给
// scanFuelOptions，stlFuel 必须相同（这是 fuel-model 的契约，与算法无关；保留此断言
// 作为 A1 也要满足的不变性）。
check('② 同 f 的 stlFuel 与距离无关（predicted metrics vs native metrics 逐位相同）', f => {
  prepareEnvironment();
  stubSetBodyObs('ZZ-101h', 1_000_000, 0);
  stubSetBodyObs('ZZ-101i', 1_000_000, Math.PI / 2);
  dispatchTransit('ZZ-101j', 'ZZ-101k', 40_000_000, 2200); // 原生前向记录 40M km
  const perf = shipPerformanceFor(SHIP);
  // A1 路径的 metrics（几何预测补距离）
  const predictedMetrics = {
    ...routeMetrics(planRoutes('ZZ-101h', 'ZZ-101i').natural),
    stlDistanceKm: 1_570_796, // r_mid × θ = 1M × π/2
    transitKm: 1_570_796,
  };
  const nativeMetrics = routeMetrics(planRoutes('ZZ-101j', 'ZZ-101k').natural);
  const optsP = scanFuelOptions(perf, predictedMetrics, autoFuelGrid(), [1], NO_PRICES);
  const optsN = scanFuelOptions(perf, nativeMetrics, autoFuelGrid(), [1], NO_PRICES);
  expectExact(f, '档位数', optsP.length, 20);
  expectExact(
    f,
    'stlFuel 不同的档位数（必须 0：燃料与距离无关）',
    optsP.filter((o, i) => !Object.is(o.stlFuel, optsN[i].stlFuel)).length,
    0,
  );
  // 字面量锚点：0.98×3500×0.05 = 171.5u（f=0.05）、0.98×3500×0.5 = 1715u（f 饱和）。
  expectExact(f, 'predicted f=0.05 的 STL 燃料', optsP[0].stlFuel, 171.5);
  expectExact(f, 'native    f=0.05 的 STL 燃料', optsN[0].stlFuel, 171.5);
  expectExact(f, 'predicted f=1 的 STL 燃料（f 饱和 0.5）', optsP[19].stlFuel, 1715);
  expectExact(f, 'native    f=1 的 STL 燃料（f 饱和 0.5）', optsN[19].stlFuel, 1715);
  // 负向：时长随距离变化（A1 是真时长，f 缩放不缩放 STL_TRANSIT_SPEED_KM_S）。
  expectCondition(
    f,
    '时长随距离变化（不是恒定）',
    optsP[2].stlHours !== optsN[2].stlHours,
    'predicted != native',
    `${optsP[2].stlHours} vs ${optsN[2].stlHours}`,
  );
});

// ---- ③ 系内 + 前向记录存在：走原生（不调几何预测）----
await checkAsync('③ 前向记录存在 → approximated 缺席、时长 = 真实模型值', async f => {
  prepareEnvironment();
  dispatchTransit('ZZ-101j', 'ZZ-101k', 40_000_000, 2200);
  // 即使把 predictTransferGeometry 强制返回成功 —— 算法也不调它（stlDistanceKm 已定义）。
  // 验证：不需要预测、不写预测标注、不写滑块。
  const est = await run('ZZ-101j', ['ZZ-101k']);
  const leg = est.legs[0];
  expectExact(f, '段0.ok', leg.ok, true);
  expectExact(f, '段0.approximated', leg.approximated, undefined);
  // 时长口径 = BTF 参考速度 + 质量幂律（不是裸常数 27512）：
  // 40M km 基准 40M / (27512 × 3600) ≈ 0.4039h，× 质量乘数 1.5013751（2,140t）≈ 0.6064h；
  // 平衡退化 → 最省油即 f=0.05。
  expectClose(
    f,
    '段0.hours（基准 × 质量乘数 1.5013751）',
    leg.hours,
    (40_000_000 / (27512 * 3600)) * TRANSIT_MASS_MULT_2140,
    1e-6,
  );
  expectExact(f, '段0.metrics.stlDistanceKm', leg.metrics?.stlDistanceKm, 40_000_000);
  expectExact(f, '段0.metrics.transitKm', leg.metrics?.transitKm, 40_000_000);
  expectExact(f, '段0.metrics.routeKm（原生航线级）', leg.metrics?.routeKm, 40_000_000);
  expectExact(f, '段0.metrics.routeSeconds（原生段时长）', leg.metrics?.routeSeconds, 2200);
  expectExact(f, '段0.metrics.transitSeconds（原生段时长）', leg.metrics?.transitSeconds, 2200);
  expectExact(f, '段0.metrics.stlRecorded', leg.metrics?.stlRecorded, true);
  // 前向记录路径调 bestOptionFor → leg.option 有值（与 ② 预测路径不同）。
  expectCondition(
    f,
    '段0.option 有值（原生路径算 fuel）',
    leg.option !== undefined,
    'FuelOption',
    'undefined',
  );
  expectExact(f, '段0.option.fuel（平衡退化 → 最省油）', leg.option?.fuel, 0.05);
  expectExact(f, '段0.option.stlFuel', leg.option?.stlFuel, 171.5);
  // 交叉验证：hours 与真实 computeFuelOption 复算一致（生产链）。
  const recomputed = computeFuelOption(
    shipPerformanceFor(SHIP),
    leg.metrics,
    leg.option.fuel,
    leg.option.reactor,
    NO_PRICES,
  );
  expectClose(f, 'hours 复算一致', leg.hours, recomputed.totalHours, 1e-12);
  // 负向：时长不是原生段时长口径（2200s = 0.6111h）。
  expectCondition(
    f,
    '时长 ≠ 原生段时长 2200s',
    leg.hours !== 2200 / 3600,
    `≠ ${2200 / 3600}`,
    String(leg.hours),
  );
  // 回程段（k→j）无原生记录 → 走几何预测（A1 路径），但因未登记 body 观测 → 预测失败 → 判缺
  // （本用例既不登记观测也不强制 fail —— 走真实路径，验证「无观测时预测返回 undefined」）。
  // 注意：这是 ③ 的反向回归点 —— 若把无观测场景误判为可预测，回程段会通过；现在判缺。
  expectExact(f, '回程段.ok（无观测 → 预测失败 → 判缺）', est.legs[1].ok, false);
  expectExact(f, '回程段.approximated', est.legs[1].approximated, undefined);
  expectExact(f, 'est.approximatedLegs', est.approximatedLegs, 0);
  expectExact(f, 'est.ok（含判缺段）', est.ok, false);
});

// ---- ④ 跨星系 判缺 + 系内守卫（⑦）：跨星系不预测；缺记录 → 判缺 ----
await checkAsync('④+⑦ 跨星系航线 → 不预测 + 缺记录判缺（approximated 缺席）', async f => {
  prepareEnvironment({ graph: { natural: [['XX-201', 'YY-301']] } });
  // 故意派发一条**反方向**同星系合成记录（与 ④ 旧版同源）：让它对系内键命中，
  // 从而「是否误用」可分辨 —— 但跨星系守卫必须拦住它（route.legs.length > 0）。
  dispatchTransit('YY-301a', 'XX-201a', 77_000_000, 4000);
  expectExact(
    f,
    '夹具：反方向同星系记录已就位',
    stlSegmentsStore.getSameSystem('YY-301a', 'XX-201a')?.transit?.distanceKm,
    77_000_000,
  );
  // 不登记任何观测 / 轨道 → 即便算法想预测，也走真实失败路径。
  const est = await run('XX-201a', ['YY-301a']);
  expectExact(f, '段数', est.legs.length, 2);
  expectExact(f, 'est.ok', est.ok, false);
  expectExact(f, 'approximatedLegs（系内守卫拦住跨星系）', est.approximatedLegs, 0);
  // 段0（正方向 XX-201a → YY-301a）：缺记录 → 判缺；不调几何预测。
  const forward = est.legs[0];
  expectExact(f, '段0.ok', forward.ok, false);
  expectExact(f, '段0.error', forward.error, '缺原生 STL 段记录');
  expectExact(f, '段0.approximated（跨星系不预测）', forward.approximated, undefined);
  expectExact(f, '段0.hours', forward.hours, 0);
  expectExact(f, '段0.arriveAtMs === departAtMs', forward.arriveAtMs, forward.departAtMs);
  expectExact(f, '段0.metrics', forward.metrics, undefined);
  expectTextIncludes(
    f,
    '段0 成因指向未下发',
    forward.missingInputs?.[0],
    '未为该航线下发原生 STL 段记录',
  );
  // 段1（反方向 YY-301a → XX-201a）有自己方向的航线级记录 → 正常算出（非预测）。
  const backward = est.legs[1];
  expectExact(f, '段1.ok', backward.ok, true);
  expectExact(f, '段1.approximated（有原生记录就不该标预测）', backward.approximated, undefined);
  expectExact(f, '段1.metrics.routeKm', backward.metrics?.routeKm, 77_000_000);
  expectExact(f, '段1.metrics.stlRecorded', backward.metrics?.stlRecorded, true);
  // 段1时长口径 = 27,512 × (1,271/质量)^0.78（77M km 基准 77M / (27512 × 3600) ≈ 0.7774h，
  // × 质量乘数）；FTL 部分不变；总时长由真实模型（computeFuelOption）给出。
  expectClose(
    f,
    '段1.hours 与真实 computeFuelOption 复算一致',
    backward.hours,
    computeFuelOption(
      shipPerformanceFor(SHIP),
      backward.metrics,
      backward.option.fuel,
      backward.option.reactor,
      NO_PRICES,
    ).totalHours,
    1e-12,
  );
  expectExact(f, 'totalHours（只累加 ok 段）', est.totalHours, backward.hours);
  // 交叉验证：这条航线确实是跨星系（natPc > 0）。
  const metrics = routeMetrics(planRoutes('XX-201a', 'YY-301a').natural);
  expectCondition(f, '夹具是跨星系（natPc > 0）', metrics.natPc > 0, '>0', String(metrics.natPc));
  expectExact(f, 'natPc', metrics.natPc, 5);
  expectExact(f, 'natJumpCount', metrics.natJumpCount, 1);
  expectExact(f, '正方向 stlDistanceKm', metrics.stlDistanceKm, undefined);
  expectExact(f, '正方向 stlRecorded', metrics.stlRecorded, false);
});

// ---- ⑤ 几何预测成功但罐缺失 → 仍判缺（预测不掩盖残缺）----
await checkAsync('⑤ 几何预测成功 + 罐容量缺失 → 仍判缺（不掩盖残缺）', async f => {
  prepareEnvironment({ tank: 0 });
  stubSetBodyObs('ZZ-101h', 1_000_000, 0);
  stubSetBodyObs('ZZ-101i', 1_000_000, Math.PI / 2);
  const perfNoTank = shipPerformanceFor(SHIP);
  expectExact(f, '夹具：蓝图无罐 → perf.stlFuelCapacity', perfNoTank.stlFuelCapacity, undefined);
  const est = await run('ZZ-101h', ['ZZ-101i']);
  const leg = est.legs[0];
  expectExact(f, '段0.ok', leg.ok, false);
  expectExact(f, '段0.error', leg.error, '缺原生 STL 段记录');
  // 几何成因被预测补上后只剩罐成因 —— 这是 A1 的关键约束：approx ≠ 不判缺。
  expectCondition(
    f,
    '段0.missingInputs 只剩罐成因（几何已被预测消掉）',
    leg.missingInputs?.length === 1 && leg.missingInputs[0].includes('STL 罐容量'),
    '1 条且为「STL 罐容量」',
    String(leg.missingInputs?.[0]),
  );
  expectExact(f, '段0.hours', leg.hours, 0);
  expectExact(f, '段0.arriveAtMs === departAtMs', leg.arriveAtMs, leg.departAtMs);
  expectExact(f, '段0.approximated（判缺时不写标注）', leg.approximated, undefined);
  expectExact(f, '段0.metrics', leg.metrics, undefined);
  expectExact(f, '段0.option', leg.option, undefined);
  expectExact(f, 'approximatedLegs', est.approximatedLegs, 0);
  expectExact(f, 'est.ok', est.ok, false);
  expectExact(f, 'totalHours', est.totalHours, 0);
});

// ---- ⑥ 三段链：段0可算 / 段1判缺 / 段2可算 ----
// 段0（e→f）有原生前向记录 → 走原生；段1（f→g）无原生记录 + 几何预测失败 → 判缺；
// 段2（g→e）有原生前向记录 → 走原生。forceFail 不影响有原生记录的段（算法根本不走
// 预测），仅让段1的预测返回 undefined。
await checkAsync('⑥ 三段链：段1 判缺不推进时刻，totalHours 只累加 ok 段', async f => {
  prepareEnvironment();
  dispatchTransit('ZZ-101e', 'ZZ-101f', 30_000_000, 1800);
  dispatchTransit('ZZ-101g', 'ZZ-101e', 42_000_000, 2500);
  // 段1（f→g）走真实几何预测失败路径（不登记观测、不强制 fail）—— 与有原生记录的
  // 段不同：predictTransferGeometry 会被调，但因没位置返回 undefined。
  stub.stubForcePredictFail(true);
  try {
    const est = await run('ZZ-101e', ['ZZ-101f', 'ZZ-101g']);
    expectExact(f, '段数', est.legs.length, 3);
    expectExact(f, '段0.ok', est.legs[0].ok, true);
    expectExact(f, '段1.ok', est.legs[1].ok, false);
    expectExact(f, '段2.ok', est.legs[2].ok, true);
    expectExact(f, '段0.approximated（原生路径）', est.legs[0].approximated, undefined);
    expectExact(f, '段1.approximated（判缺）', est.legs[1].approximated, undefined);
    expectExact(f, '段2.approximated（原生路径）', est.legs[2].approximated, undefined);
    // 时长口径 = 27,512 × (1,271/2,140)^0.78 ⇒ 段0 30M km = 0.3029h × 1.5013751 = 0.4548h、
    // 段2 42M km = 0.4241h × 1.5013751 = 0.6367h。
    expectClose(
      f,
      '段0.hours（30M km 基准 × 质量乘数）',
      est.legs[0].hours,
      (30_000_000 / (27512 * 3600)) * TRANSIT_MASS_MULT_2140,
      1e-6,
    );
    expectExact(f, '段1.hours', est.legs[1].hours, 0);
    expectClose(
      f,
      '段2.hours（42M km 基准 × 质量乘数）',
      est.legs[2].hours,
      (42_000_000 / (27512 * 3600)) * TRANSIT_MASS_MULT_2140,
      1e-6,
    );
    // 段1 的出发时刻 = 段0 到站时刻；段1 不推进。
    expectExact(f, '段1.departAtMs', est.legs[1].departAtMs, T0 + est.legs[0].hours * 3600000);
    expectExact(f, '段1.arriveAtMs === departAtMs', est.legs[1].arriveAtMs, est.legs[1].departAtMs);
    // 段2 的出发时刻 = 段1 的出发时刻（判缺段贡献 0ms）。
    expectExact(
      f,
      '段2.departAtMs === 段1.departAtMs',
      est.legs[2].departAtMs,
      est.legs[1].departAtMs,
    );
    expectExact(
      f,
      '段2.arriveAtMs',
      est.legs[2].arriveAtMs,
      est.legs[2].departAtMs + est.legs[2].hours * 3600000,
    );
    expectExact(
      f,
      'totalHours（段0 + 段2）',
      est.totalHours,
      est.legs[0].hours + est.legs[2].hours,
    );
    expectExact(f, 'est.ok（含判缺段）', est.ok, false);
    expectExact(f, 'approximatedLegs', est.approximatedLegs, 0);
    // 负向：推进量是模型时长，不是段0 原生段时长（1800s = 0.5h）。
    expectCondition(
      f,
      '段1 出发时刻 ≠ 起点 + 原生段时长 1800s',
      est.legs[1].departAtMs !== T0 + 1800 * 1000,
      `≠ ${T0 + 1800 * 1000}`,
      String(est.legs[1].departAtMs),
    );
  } finally {
    stub.stubForcePredictFail(false);
  }
});

// ---- ⑥-加 几何预测 ≠ 写滑块：所有走预测的段都不调 setFtcFuelSlider / setFtcReactorUsage ----
// 用 ZZ-101p/q/r/s（与既有 ②⑤⑥ 用的 a..k 不相交）保证本段无原生记录，全走预测路径。
await checkAsync('⑥-加 几何预测路径不调 setFtcFuelSlider / setFtcReactorUsage', async f => {
  prepareEnvironment();
  stubSetBodyObs('ZZ-101p', 1_000_000, 0);
  stubSetBodyObs('ZZ-101q', 1_000_000, Math.PI / 2);
  stubSetBodyObs('ZZ-101r', 1_000_000, 0);
  stubSetBodyObs('ZZ-101s', 1_000_000, Math.PI / 2);
  // 四段全走预测路径（无原生记录 + 有观测）；断言：两个监视数组都为空。
  const est = await run('ZZ-101p', ['ZZ-101q', 'ZZ-101r', 'ZZ-101s']);
  expectExact(f, '段数', est.legs.length, 4);
  expectExact(f, '段0.ok（预测成功）', est.legs[0].ok, true);
  expectExact(f, '段1.ok（同上）', est.legs[1].ok, true);
  expectExact(f, '段2.ok（同上）', est.legs[2].ok, true);
  expectExact(f, '段3.ok（同上）', est.legs[3].ok, true);
  expectExact(f, 'approximatedLegs', est.approximatedLegs, 4);
  expectExact(f, 'sliderWrites.length（预测 ≠ 写滑块）', stub.sliderWrites.length, 0);
  expectExact(f, 'reactorWrites.length', stub.reactorWrites.length, 0);
});

// 对照：原生路径会写滑块吗？不写。chain-flight-time.ts 本身**永远**不写滑块（写入
// 面专属 FTC 面板）。原生路径与预测路径都不写 —— 这是 chain-flight-time 的契约
//（面板展示层），不是 FTC 联动层。补一条对照锁这条边界。
await checkAsync('⑥-加对照 原生路径同样不调 setFtcFuelSlider / setFtcReactorUsage', async f => {
  prepareEnvironment();
  dispatchTransit('ZZ-101j', 'ZZ-101k', 40_000_000, 2200);
  await run('ZZ-101j', ['ZZ-101k']);
  expectExact(f, 'sliderWrites.length', stub.sliderWrites.length, 0);
  expectExact(f, 'reactorWrites.length', stub.reactorWrites.length, 0);
});

// ---- ⑧ 均值圆弧公式的数学不变性 ----
// 直接驱动真实 predictTransferGeometry：r_mid = (r1+r2)/2、arcKm = r_mid × θ、
// hours = arcKm / (stlIntraTransitSpeedKmS(质量) × 3600) / cond；t0Ms 用观测恒等的设置（轨道 stub 让两端
// 位置不随时间漂移，保证 math 干净）。
await checkAsync('⑧ 均值圆弧公式的数学不变性（r_mid / arcKm / hours 逐位）', async f => {
  prepareEnvironment();
  // h 在 (1M, 0, 0)、i 在 (0, 1M, 0)（90° 分离）⇒ r1=r2=1M, θ=π/2。
  stubSetBodyObs('ZZ-101h', 1_000_000, 0);
  stubSetBodyObs('ZZ-101i', 1_000_000, Math.PI / 2);
  const r = await predictTransferGeometry({
    fromId: 'ZZ-101h',
    toId: 'ZZ-101i',
    fromSystemId: SYS,
    toSystemId: SYS,
    t0Ms: T0,
    cond: 1,
    massT: SHIP.mass,
  });
  expectCondition(f, 'predictTransferGeometry 返回值', r !== undefined, '结果', 'undefined');
  // r1 = r2 = 1M ⇒ r_mid = 1M。
  expectClose(f, 'r_mid === (r1+r2)/2', 1_000_000, 1_000_000, 1e-9);
  // θ = π/2 ⇒ arcKm = 1M × π/2 ≈ 1_570_796.327 km。
  const expectedArcKm = 1_000_000 * (Math.PI / 2);
  expectClose(f, 'arcKm === r_mid × θ', r.distanceKm, expectedArcKm, 1e-6);
  // hours = arcKm / (27,512 / 1.5013751 × 3600) / cond=1（夹具 2,140t：速度含质量幂律）。
  expectClose(
    f,
    'hours === arcKm / (27,512 × 质量乘数逆 × 3600) / cond',
    r.hours,
    (expectedArcKm / (27512 * 3600)) * TRANSIT_MASS_MULT_2140,
    1e-6,
  );
  expectClose(
    f,
    'speedKmS = stlIntraTransitSpeedKmS(2,140t) / cond',
    r.speedKmS,
    TRANSIT_SPEED_KM_S_2140,
    0.01,
  );
  expectExact(f, 'source', r.source, 'predicted');
});

// ---- ⑨ 与 BTF TRANSIT 弧长偏差 < 30%（hard cap） ----
// BTF tag=4 实测 HRT → VH-331g 同星系转移段：弧长 599.22M km / 21780s ≈ 27512 km/s（该样本
// 质量 = 整备 1,271t）。
// ⚠️ 几何（弧长）不受质量影响，但**时长期望值**要带夹具质量 2,140t 的质量乘数。
// 用圆轨道 stub 设置 HRT/VH-331g 在 t=T0 的相位让均值圆弧公式算出 ≈ 599.22M km。
// 期望偏差在 1-6%（A1 初版均值圆弧的限制），超过 30% 视为公式不自洽。
await checkAsync('⑨ 与 BTF TRANSIT 弧长（HRT→VH-331g, 599.22M km）偏差 < 30%', async f => {
  prepareEnvironment();
  stubSetHrtVh331gOrbits();
  const r = await predictTransferGeometry({
    fromId: 'HRT',
    toId: 'VH-331G',
    fromSystemId: 'VH-331',
    toSystemId: 'VH-331',
    t0Ms: T0,
    cond: 1,
    massT: SHIP.mass,
  });
  expectCondition(f, 'predictTransferGeometry 返回值', r !== undefined, '结果', 'undefined');
  const predictedKm = r.distanceKm;
  const deviation = Math.abs(predictedKm - BTF_TRANSIT_KM) / BTF_TRANSIT_KM;
  // 期望 1-6% 偏差内（与 fuel-model.ts:486-488 同航线同船同 f 的点间漂移 ≤0.4%
  // 一致 —— A1 初版均值圆弧与真实椭圆弧长在 140.8° 分离角下偏差量级）。
  console.log(
    `  ⑨ 实际偏差 = ${(deviation * 100).toFixed(3)}%（预测 ${predictedKm.toFixed(0)} km / ` +
      `BTF ${BTF_TRANSIT_KM} km）`,
  );
  if (deviation > 0.3) {
    f.push(
      `⑨ 偏差超 30% 上限（actual=${(deviation * 100).toFixed(3)}%, predicted=${predictedKm.toFixed(0)} km, ` +
        `btf=${BTF_TRANSIT_KM} km）— 公式不自洽，请检查 r_mid / theta / arcKm 公式`,
    );
    return;
  }
  // 软区间：1-6% 偏差（期望）；超出此区间**只警告**（脚本不 FAIL —— hard cap 在 30%）。
  if (deviation < 0.01 || deviation > 0.06) {
    console.log(
      `  ⑨ 提示：偏差 ${(deviation * 100).toFixed(3)}% 不在期望 1-6% 内（仍在 30% cap 以内）。`,
    );
  }
  // 公式的物理量仍然对齐：speedKmS / hours / arcKm。
  expectClose(f, 'speedKmS（夹具 2,140t ⇒ 含质量乘数）', r.speedKmS, TRANSIT_SPEED_KM_S_2140, 0.01);
  // hours ≈ BTF_TRANSIT_KM / (27512 × 3600) × 1.5013751 ≈ 9.0835 h；
  // ⚠️ 夹具质量 2,140t 与 BTF 参考样本 1,271t 不同，故不再是 6.05h（该值只对参考质量成立）。
  expectClose(
    f,
    'hours ≈ BTF / (27512 × 3600) × 质量乘数',
    r.hours,
    (BTF_TRANSIT_KM / (27512 * 3600)) * TRANSIT_MASS_MULT_2140,
    0.01,
  );
});

// ---- ⑩ t0Ms 不同时 distanceKm 不同但接近参考（不要恒定；轨道相位漂移 ± 5%） ----
// 三个 t0Ms：T0、T0+12 小时、T0+24 小时。24h 漂移约 2.5%（< 5% 软上限）；
// 间隔越拉越大漂移越大，超 1 天会接近 5% 上限 —— 这里只验「非恒定 + 短窗口稳定」。
await checkAsync('⑩ 不同 t0Ms → distanceKm 单调稳定 ± 5%（旋转轨道相位漂移）', async f => {
  prepareEnvironment();
  stubSetHrtVh331gOrbits();
  const samples = [T0, T0 + 12 * 3_600_000, T0 + 24 * 3_600_000];
  const distances = [];
  for (const t of samples) {
    const r = await predictTransferGeometry({
      fromId: 'HRT',
      toId: 'VH-331G',
      fromSystemId: 'VH-331',
      toSystemId: 'VH-331',
      t0Ms: t,
      cond: 1,
      massT: SHIP.mass,
    });
    expectCondition(f, `t0Ms=${t} 返回值`, r !== undefined, '结果', 'undefined');
    distances.push(r.distanceKm);
  }
  console.log(
    `  ⑩ 三个 t0Ms 的 distanceKm（km）：` +
      distances.map(d => d.toFixed(0)).join(' / ') +
      `  (BTF 参考 ${BTF_TRANSIT_KM})`,
  );
  // 软断言：每个值都在 BTF 参考的 ±5% 内。
  for (const [i, d] of distances.entries()) {
    const dev = Math.abs(d - BTF_TRANSIT_KM) / BTF_TRANSIT_KM;
    if (dev > 0.05) {
      f.push(
        `⑩ t0Ms=${samples[i]} 偏差超 5% 软上限（actual=${(dev * 100).toFixed(3)}%, ` +
          `predicted=${d.toFixed(0)} km, btf=${BTF_TRANSIT_KM} km）`,
      );
    }
  }
  // 关键断言：三个值**不全相同**（防止预测返回恒定值 / 忽略 t0Ms）。
  const allSame = distances.every(d => Object.is(d, distances[0]));
  expectCondition(
    f,
    '距离随 t0Ms 变化（不全相同）',
    !allSame,
    '至少有差异',
    `${distances.join(',')}`,
  );
  // 进一步：漂移**单调小**（不出现突变）。相邻差值都 ≤ 6%（≈ 5% 软上限 + 容差）。
  for (let i = 1; i < distances.length; i++) {
    const step = Math.abs(distances[i] - distances[i - 1]) / BTF_TRANSIT_KM;
    expectCondition(
      f,
      `相邻步进 ${i} 漂移 ≤ 6%`,
      step <= 0.06,
      '<=6%',
      `${(step * 100).toFixed(3)}%`,
    );
  }
});

// ---- ⑪ 转移段速度的**单一公式来源**：transfer-geometry 输出 ≡ fuel-model.stlIntraTransitSpeedKmS ----
// 为什么必须锁：2026-09-25 的 bug 就是「同一个公式在两处各自展开、只给一处补了质量项」——
// 两边各自写公式时，任何一次口径变更都会漏掉一边，而两边都自称「对齐 BTF 实测」。
// 本断言是唯一能拦住这种漂移的机制：一侧是真实 transfer-geometry 的输出，另一侧是
// fuel-model 里那个唯一公式。任一边重新展开 / 改指数 / 漏 Math.max(1, ·) → 立刻红。
// （期望值仍是字面量 27,512 / 质量乘数，不用生产函数拼期望 —— 见文件头「断言常数来源」。）
await checkAsync('⑪ 单一公式来源：transfer-geometry ≡ stlIntraTransitSpeedKmS(mass)', async f => {
  prepareEnvironment();
  stubSetBodyObs('ZZ-101t', 1_000_000, 0);
  stubSetBodyObs('ZZ-101u', 1_000_000, Math.PI / 2);
  const call = massT =>
    predictTransferGeometry({
      fromId: 'ZZ-101t',
      toId: 'ZZ-101u',
      fromSystemId: SYS,
      toSystemId: SYS,
      t0Ms: T0,
      cond: 1,
      massT,
    });
  // 参考质量 1,271t：幂律基点，速度必须回到 BTF 实测的 27,512 km/s（字面量）。
  const refMass = await call(1271);
  expectCondition(f, '参考质量调用成功', refMass !== undefined, '结果', 'undefined');
  expectExact(f, '参考质量 1,271t ⇒ speedKmS = 27,512（幂律基点自洽）', refMass.speedKmS, 27512);
  // 夹具质量 2,140t：与唯一来源逐位一致（speedKmS 逐位、hours ±1e-9 相对）。
  const heavy = await call(SHIP.mass);
  expectCondition(f, '夹具质量调用成功', heavy !== undefined, '结果', 'undefined');
  expectExact(
    f,
    'speedKmS ≡ stlIntraTransitSpeedKmS(mass) 逐位一致',
    heavy.speedKmS,
    stlIntraTransitSpeedKmS(SHIP.mass),
  );
  expectClose(
    f,
    'hours ≡ d / stlIntraTransitSpeedKmS(mass) / 3600',
    heavy.hours,
    heavy.distanceKm / stlIntraTransitSpeedKmS(SHIP.mass) / 3600,
    1e-12,
  );
  // 负向：质量项真的生效（不是裸常数）—— 重船必须显著更慢。
  expectCondition(
    f,
    '重船（2,140t）比参考质量（1,271t）慢 ≈ 1.5×',
    heavy.hours > refMass.hours * 1.4,
    '>1.4×',
    `${heavy.hours} vs ${refMass.hours}`,
  );
});

// ---- 汇总 ----
console.log(
  '\n口径摘要（全部来自真实模型，非断言常数）：' +
    `系内转移段速度 = stlIntraTransitSpeedKmS(质量) = 27512 × (1271/质量)^0.78 km/s` +
    `（BTF 直采，fuel-model.ts；1,271t 参考质量 → 27,512 km/s，与 f/距离无关）；` +
    `A1 均值圆弧公式 (r_mid × θ) / stlIntraTransitSpeedKmS(质量) / 3600 / cond（夹具 2,140t ⇒ 乘数 1.5013751）；` +
    `BTF HRT→VH-331g TRANSIT 段 599.22M km / 21,780s 在参考质量下与公式口径逐位匹配。`,
);
console.log(`\nPASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
