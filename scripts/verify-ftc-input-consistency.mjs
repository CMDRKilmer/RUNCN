// FTC 输入完整性 + 两路径一致性回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-23 修复的 bug）：用户实测「SFC 里自动拉条和 FTC 计算出来的不一致」。
// 根因：同星系航线（如 zv-307a → ANT，两者同在 ZV-307）的 STL 燃料只有唯一来源
//   stlDistanceKm = liftOffKmAt(起点) + liftOffKmAt(终点)   ← 起终点到本星恒星的轨道半径
// （同星系 legs 为空 → routeMetrics 不查 stlSegmentsStore；也不走 STL_EST_* 常数）。
// 空间站轨道不在内置数据里（public/json/stations.json 只内置归属星系，仅 HRT 带轨道），
// 只能靠浏览星系运行时积累：
//   FTC 面板（browse:true，会浏览起终点星系）→ 几何完整 → f = 0.2；
//   SFC 联动（browse:false，不许开窗）→ liftOffKmAt(ANT) = undefined →
//   stlDistanceKm = undefined → 同星系分支 stlFuel ≡ 0（燃料无梯度但时间仍有梯度）
//   → findBalanceOption 退化 → f = 1（修复前）/ 0.05（退化保护后），与面板不一致。
//
// **2026-09-23 二次修订（用户拍板「不需要回退，永远等服务器下发」）**：几何来源已改为
// 「只取服务器下发的原生 STL 段记录」，`liftOffKmAt` 与 `STL_EST_*` 均已删除 —— 本脚本
// 的断言不变（missingModelInputs 判缺 + 门控不写滑块，这里注入的是 metrics，与来源无关），
// 但「残缺」的成因口径已变：不再是「空间站轨道未积累」，而是「服务器尚未下发该航线的
// 原生 STL 段记录」。
//
// 锁定的行为契约：
//   ① missingModelInputs 判定「模型必需输入」：**无条件**缺 stlDistanceKm（undefined 或 0
//      —— 两条分支都消费它，跨星系时它是 stlHours 的回退项，缺了 STL 时长被静默记 0；
//      系内时它是「转移」段时长 d/v_转移 的唯一来源）、缺 STL 罐余量/容量（跨星系离港/进近
//      与**系内转移段**的燃料都是罐口径：0.49×罐×f / 2×0.49×罐×min(f,0.5)）
//      → 非空（残缺，结果不可写入 SFC 滑块）；输入完整 → 空数组。
//   ② 同几何输入下模型输出一致（纯函数；不同实体文本/不同几何 → 有区分度），且用面板
//      实测 d 复算与面板结果吻合 —— **不**声称「面板路径与 SFC 路径端到端一致」（SFC
//      联动不开窗，几何确实可能残缺，此时按 ① 拦下而非硬算；复算参数：标准引擎/罐 3500/
//      G8/空重 1271t/流量 0.015，质量 2140t 由截图分段时长 1h14m41s + 22m25s 反解）。
//   ③ 输入残缺（无该航线原生记录 → stlDistanceKm undefined）时结果不可采信 →
//      必须被 ① 拦下（computeFtcPlan 不写滑块、SFC 跳过刷新）。
//      ⚠️ 2026-09-23 口径标定后：系内燃料 = 0.98×罐×min(f,0.5) 与距离无关，故「残缺 ⇔
//      燃料无梯度」不再等价（燃料仍有梯度，时间梯度才依赖 d）—— 契约只认 ① 的判定。
//   ④ 门控集成（2026-09-23 复核后新增）：stub loader 驱动**真实** computeFtcPlan
//      （scripts/lib/ftc-node-loader.mjs + ftc-node-stub.mjs），断言
//      「残缺输入 → inputIncomplete 非空 → 未进入 setFtcFuelSlider/setFtcReactorUsage」。
//   ⑤ 油罐查表（2026-09-25 新增）：shipFuelRemainingFor 必须按 **store id** 查
//      （storagesStore.getById），不是 getByAddressableId（键 = 仓库可寻址地址）——
//      后者键类型不匹配 → 余量/容量恒 0（用户实测「当前油量 STL 0/0 ｜ FTL 0/0」+ 假缺口），
//      并连带把 ShipPerformance.stlRemaining（转移段燃料/速度的乘性基准）打回 0。
//
// 用法：node scripts/verify-ftc-input-consistency.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 直接导入真实模型（Node ≥ 22.18 原生 TS 类型剥离），避免手抄公式引入偏差。
// 门控集成用例额外用 module.register 钩子替换编排层的浏览器依赖（见文件末尾注释），
// 生产代码与真实模型本身零改动。
import { register } from 'node:module';
import {
  autoFuelGrid,
  computeFuelOption,
  findBalanceOption,
  missingModelInputs,
  scanFuelOptions,
} from '../src/features/XIT/FTC/fuel-model.ts';
import { SHIP, DEPART_KM, APPROACH_KM } from './lib/ftc-node-fixtures.mjs';

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

function expectExact(failures, label, actual, expected) {
  if (!Object.is(actual, expected)) {
    failures.push(`expected=${expected} actual=${actual} (${label})`);
  }
}
function expectCondition(failures, label, ok, expectedText, actualText) {
  if (!ok) {
    failures.push(`expected=${expectedText} actual=${actualText} (${label})`);
  }
}

// 截图实测飞船性能取自 scripts/lib/ftc-node-fixtures.mjs（与门控集成用例共用同一份参数，
// 单一来源避免脚本间手抄漂移）：AVI-06JVV（BP-ZXWK-1228）标准引擎 / 罐 3500 / G8 /
// 空重 1271t / 流量 0.015 u/s / FTL 2.84 pc/h；当前油量 STL 0/0 → stlRemaining undefined
// （回退罐容量）。当前质量 2140t 由截图分段时长（离港 1h14m41s / 进近 22m25s）反解。
const NO_PRICES = { stlPrice: 0, ftlPrice: 0, timeValue: 0 };
const SUM = o => o.stlFuel + o.ftlFuel;

// 截图航线几何（同星系，无自然跃迁 → reactors = [1]，与 ftc-compute 一致）：
// zv-307a → ANT；68.0562M + 33.6491M = 面板「航线分段（**模型估算**）」显示的距离（非原生）；
// 面板 best.stlFuel = 580.7205u。
const sameSystem = (departKm, approachKm) => ({
  stlDistanceKm:
    departKm !== undefined && approachKm !== undefined ? departKm + approachKm : undefined,
  departKm,
  approachKm,
  natPc: 0,
  gwPc: 0,
  gwCount: 0,
  natJumpCount: 0,
  fromBody: 'zv-307a',
  toBody: 'ANT',
});
// 跨星系几何（有自然跃迁 → 罐模型 0.49×罐×f 生效）。罐容量/余量由**飞船对象**决定，
// 这里不再放一个控制不了任何东西的 `_tank` 参数（旧写法误导：看似能切罐、实际无效）。
// 系内**真实**结构（只有「转移」段，无离港/进近拆分）→ 只给整段 d，用于锁
// 「燃料与 d 无关（罐口径）、时长随 d 线性（转移段速度模型）」（2026-09-23 标定）。
const transitOnly = d => ({
  stlDistanceKm: d,
  departKm: undefined,
  approachKm: undefined,
  transitKm: d,
  natPc: 0,
  gwPc: 0,
  gwCount: 0,
  natJumpCount: 0,
  fromBody: 'zv-307a',
  toBody: 'ANT',
  fromIsSystem: false,
  toIsSystem: false,
  stationReverse: [],
});
const crossSystem = () => ({
  ...sameSystem(DEPART_KM, APPROACH_KM),
  natPc: 3.2,
  natJumpCount: 1,
});

// ---- ① missingModelInputs：必需输入判定 ----
const complete = sameSystem(DEPART_KM, APPROACH_KM);
const noApproach = sameSystem(DEPART_KM, undefined);
const noDepart = sameSystem(undefined, APPROACH_KM);

check('missingModelInputs：同星系几何完整 → 不报缺（可写入滑块）', f => {
  expectExact(f, '长度', missingModelInputs(SHIP, complete).length, 0);
});
check('missingModelInputs：同星系缺进近（无原生记录）→ 报缺', f => {
  const missing = missingModelInputs(SHIP, noApproach);
  expectCondition(f, '报缺', missing.length === 1, '1 条缺失', `${missing.length} 条`);
  expectCondition(
    f,
    '指向起终点轨道距离',
    missing[0]?.includes('轨道距离') === true,
    '含「轨道距离」',
    String(missing[0]),
  );
  expectCondition(
    f,
    '点名终点实体',
    missing[0]?.includes('ANT') === true,
    '含 ANT',
    String(missing[0]),
  );
});
check('missingModelInputs：同星系缺离港 → 报缺', f => {
  expectExact(f, '缺失条数', missingModelInputs(SHIP, noDepart).length, 1);
});
check('missingModelInputs：d = 0（起终点同一天体）→ 报缺（燃料恒 0 无梯度）', f => {
  expectExact(f, '缺失条数', missingModelInputs(SHIP, sameSystem(0, 0)).length, 1);
});
check('missingModelInputs：跨星系缺罐容量 → 报缺（罐模型不可用）', f => {
  const ship = { ...SHIP, stlFuelCapacity: undefined, stlRemaining: undefined };
  const missing = missingModelInputs(ship, crossSystem());
  expectCondition(f, '报缺', missing.length === 1, '1 条缺失', `${missing.length} 条`);
  expectCondition(
    f,
    '指向罐容量',
    missing[0]?.includes('罐容量') === true,
    '含「罐容量」',
    String(missing[0]),
  );
});
check('missingModelInputs：跨星系有罐余量（虽无蓝图容量）→ 不报缺', f => {
  const ship = { ...SHIP, stlFuelCapacity: undefined, stlRemaining: 1500 };
  expectExact(f, '缺失条数', missingModelInputs(ship, crossSystem()).length, 0);
});
check('missingModelInputs：跨星系有蓝图罐容量 → 不报缺', f => {
  expectExact(f, '缺失条数', missingModelInputs(SHIP, crossSystem()).length, 0);
});

// ---- ② 一致性：几何相同时两条路径给出同一个 best.fuel ----
function balance(metrics, ship = SHIP, reactors = [1]) {
  const options = scanFuelOptions(ship, metrics, autoFuelGrid(), reactors, NO_PRICES);
  return { options, best: findBalanceOption(options) };
}

check('一致性：完整几何下 best.fuel = 0.15、燃料 = 0.98×罐×min(f,0.5)（系内罐口径）', f => {
  const { best } = balance(complete);
  expectExact(f, 'best.fuel', best?.fuel, 0.15);
  // 系内燃料 = 0.98×罐 3500×min(0.15,0.5) = 514.5u（旧 C_F×f×d 口径在同 d 给 434.6u；
  // 面板截图当年的 580.7205u = 已删除的自建轨道几何（d = 101.8808M）+ 已证伪的 C_F×f×d）。
  expectCondition(
    f,
    '燃料量级',
    best !== undefined && Math.abs(best.stlFuel - 514.5) < 0.5,
    '514.5 ±0.5（= 0.98×罐3500×min(f,0.5)）',
    String(best?.stlFuel),
  );
  // 面板当年的 d 与原生 d 差 0.17%，但**系内燃料与 d 无关** → 两个 d 给出逐位相同的
  // 燃料与时长（旧口径下会差 ~1u：579.72 vs 580.72）。
  const panelD = 101.8808e6;
  const { best: panelBest } = balance(sameSystem(panelD - APPROACH_KM, APPROACH_KM));
  expectExact(f, '面板 d 的 best.fuel', panelBest?.fuel, 0.15);
  expectExact(f, '面板 d 的燃料（与 d 无关）', panelBest?.stlFuel, best?.stlFuel);
});
check('一致性：质量从空重到满载，best.fuel 恒为 0.15（几何相同 → 参数一致）', f => {
  for (const mass of [1271, 1600, 2140, 2600, 3200]) {
    const { best } = balance(complete, { ...SHIP, mass });
    expectExact(f, `质量 ${mass}t 的 best.fuel`, best?.fuel, 0.15);
  }
});
// ⚠️ 原「browse=false（SFC）与 browse=true（面板）几何一致时结果一致」用例两侧输入
// 完全相同 → 恒真、零区分度（2026-09-23 复核发现），已替换为下面两条真正有区分度的用例：
// ① 输入确有差异（实体文本/几何数值）但要么同几何（须同输出）、要么几何 ×2（须变）。
check('一致性：几何相同、实体文本不同 → 输出逐位相同（模型只依赖几何，不依赖实体名）', f => {
  const plain = balance(complete);
  // 仅改实体文本（含大小写差异），几何数值完全不变。
  const aliased = balance({ ...complete, fromBody: 'ZV-307A', toBody: 'ANT同名别名' });
  expectExact(f, 'best.fuel', aliased.best?.fuel, plain.best?.fuel);
  expectExact(f, 'stlFuel', aliased.best?.stlFuel, plain.best?.stlFuel);
  expectExact(f, 'totalHours', aliased.best?.totalHours, plain.best?.totalHours);
});
// ⚠️ 旧用例「几何 ×2 → 燃料显著变化」已作废：2026-09-23 标定后系内燃料 = 0.98×罐×
// min(f,0.5)（**与距离无关**，见 fuel-model 的 STL_TRANSIT_F_SAT 上方）→ 燃料不随 d 变。
// 改为锁新口径的两条腿：燃料与 d 无关（固定 f 下逐位相同）+ 时长随 d 严格线性
// （证明几何仍然被消费、上述「相同」不是因为模型忽略了 d）。用固定 f = 0.2 对照。
check('敏感性：系内燃料与 d 无关（罐口径）；时长在固定 f 下随 d 线性（几何仍被消费）', f => {
  const dNear = DEPART_KM + APPROACH_KM;
  const fuelAt = d => computeFuelOption(SHIP, transitOnly(d), 0.2, 1, NO_PRICES).stlFuel;
  const hoursAt = d => computeFuelOption(SHIP, transitOnly(d), 0.2, 1, NO_PRICES).stlHours;
  // 燃料 = 0.98×3500×min(0.2,0.5) = 686u，与 d 无关。
  expectCondition(
    f,
    '近 d 燃料 = 686u',
    Math.abs(fuelAt(dNear) - 686) < 0.01,
    '686 ±0.01',
    String(fuelAt(dNear)),
  );
  expectExact(f, '远 d（×2）燃料逐位相同', fuelAt(dNear * 2), fuelAt(dNear));
  // 时长 = d / v_转移 → 距离翻倍时长翻倍（旧「巡航模型」也线性，但速率不同：新式
  // f=0.2 给 27,273 km/s，旧式给 55,009 km/s —— 若实现退回旧式，下面这行仍会过，
  // 故同时锁住速度量级）。
  const ratio = hoursAt(dNear * 2) / hoursAt(dNear);
  expectCondition(
    f,
    '时长随 d 线性（×2 ±1e-9）',
    Math.abs(ratio - 2) < 1e-9,
    '2 ±1e-9',
    String(ratio),
  );
  const vTransit = dNear / (hoursAt(dNear) * 3600);
  // ⚠️ 断言变更记录（2026-09-24）：原值 **27,273 km/s**（旧引擎表拟合式 f=0.2 给的速率，
  //   V_SAT×(f/0.5)^0.84×massFactor）→ 改为 **27,512 km/s**（BTF 组 4 VH-331g→HRT
  //   实测，见 fuel-model.ts STL_INTRA_TRANSIT_SPEED_KM_S 上方）。本次同时把 computeFuelOption
  //   的 restKm 段速度从「引擎拟合式」改为该船无关常数，旧拟合式在 500M km 量级高估 ~2×
  //   （同输入旧式给 55,009 → 与新值 27,512 差 ~2×）。属**断言过时**，非回归。
  // ⚠️ 断言变更记录（2026-09-25）：**27,512 → 18,322 km/s**。理由：用户实测（2,727t 船
  //   15,186 km/s vs 参考样本 1,271t 的 27,512 km/s）证伪「船无关常数」→ 27,512 只是
  //   **参考质量 1,271t 时**的速度；本夹具 SHIP.mass = 2,140t →
  //   27512 × (1271/2140)^0.78 = 18,324.5 km/s（期望字面量取 18,322，容差 ±5 覆盖取整）。
  expectCondition(
    f,
    '转移段速度 = 27512 × (1271/2140)^0.78 = 18,322 km/s（旧常数口径给 27,512、旧拟合式给 55,009）',
    Math.abs(vTransit - 18322) < 5,
    '18,322 ±5 km/s',
    String(Math.round(vTransit)),
  );
});

// ---- ③ 残缺输入：必须被 ① 拦下（不得写入滑块）----
// ⚠️ 2026-09-23 口径标定后「同星系燃料无梯度」不再成立：系内燃料 = 0.98×罐×min(f,0.5)
// 与距离无关 → 即使缺几何也有燃料梯度（时间梯度才依赖 d / 离港进近段）。
// 但**门控仍然拦住**：几何残缺 → missingModelInputs 非空 → 不写滑块（这才是契约本身）。
check('残缺：缺进近（无原生记录）→ 拦下不写；燃料有梯度（罐口径）、时间有梯度（离港段）', f => {
  const { options, best } = balance(noApproach);
  const fuels = options.map(SUM);
  const hours = options.map(o => o.totalHours);
  const fuelSpan = Math.max(...fuels) - Math.min(...fuels);
  const timeSpan = Math.max(...hours) - Math.min(...hours);
  expectCondition(f, '燃料有梯度（罐口径）', fuelSpan > 1e-9, '>1e-9', fuelSpan.toExponential(2));
  expectCondition(
    f,
    '时间有梯度（离港段已给）',
    timeSpan > 1e-9,
    '>1e-9',
    timeSpan.toExponential(2),
  );
  expectCondition(
    f,
    '被拦下（不可写入滑块）',
    missingModelInputs(SHIP, noApproach).length > 0,
    '>0 条缺失',
    '0 条',
  );
  // 退化保护（上一轮修复）仍生效：绝不返回最快方案 f=1。
  expectCondition(f, '非最快方案', best !== undefined && best.fuel !== 1, 'f≠1', `f=${best?.fuel}`);
});
check('残缺：缺离港 → 拦下不写；燃料仍按罐口径有梯度', f => {
  const { options } = balance(noDepart);
  const fuels = options.map(SUM);
  expectCondition(
    f,
    '燃料有梯度（罐口径）',
    Math.max(...fuels) - Math.min(...fuels) > 1e-9,
    '>1e-9',
    (Math.max(...fuels) - Math.min(...fuels)).toExponential(2),
  );
  expectExact(f, '缺失条数', missingModelInputs(SHIP, noDepart).length, 1);
});
check('残缺：d 全缺 → 拦下不写；时间跨度 0（无 d）、燃料仍有梯度（罐口径）', f => {
  const { options } = balance(sameSystem(undefined, undefined));
  const fuels = options.map(SUM);
  const hours = options.map(o => o.totalHours);
  expectCondition(
    f,
    '燃料有梯度（罐口径）',
    Math.max(...fuels) - Math.min(...fuels) > 1e-9,
    '>1e-9',
    (Math.max(...fuels) - Math.min(...fuels)).toExponential(2),
  );
  expectExact(f, '时间跨度', Math.max(...hours) - Math.min(...hours), 0);
  expectExact(f, '缺失条数', missingModelInputs(SHIP, sameSystem(undefined, undefined)).length, 1);
});
check('退化输入不得抛异常且仍返回可用结构', f => {
  const { best } = balance({ ...sameSystem(undefined, undefined) });
  expectCondition(f, 'best 存在', best !== undefined, 'FuelOption', String(best));
  expectCondition(
    f,
    'stlFuel 有限',
    Number.isFinite(best?.stlFuel),
    '有限数值',
    String(best?.stlFuel),
  );
});

// ---- ④ 门控集成：真实 computeFtcPlan（stub loader 替换浏览器侧依赖）----
// 目的：上一轮新增的门控逻辑（inputIncomplete → 不写滑块）此前**没有**任何自动化覆盖
// （脚本只 import 纯模型），这里在 Node 里驱动真实编排层断言「是否进入写入路径」。
// 局限（明确记录，见 scripts/lib/ftc-node-stub.mjs）：浏览星系/行星环境 JSON/蓝图异步等待
// 走替身；本用例覆盖「输入完整性判定 → 门控 → 是否写滑块」这一段，不覆盖 DOM 与 store 行为。
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

// 行星环境数据加载（跨星系分支会走 fetchPlanetEnv）：config 是构建期自动导入的全局，
// Node 里注入最小替身；fetch 也只返回空 JSON（无起降段，不影响门控断言）。
register('./lib/ftc-node-loader.mjs', import.meta.url);
globalThis.config = { url: { planetEnv: 'https://stub.invalid/planet-env.json' } };
globalThis.fetch = async () => ({ json: async () => ({}) });

const stub = await import('./lib/ftc-node-stub.mjs');
const { computeFtcPlan, shipPerformanceFor, shipFuelRemainingFor } = await import(
  '../src/features/XIT/FTC/ftc-compute.ts'
);

const stubRoute = (metrics, stlFuelCapacity = SHIP.stlFuelCapacity) => {
  stub.stubSetShip(stub.STUB_SHIP);
  stub.stubSetBlueprint(stub.stubBlueprint(stlFuelCapacity));
  stub.stubSetRoute(
    'zv-307a',
    'ANT',
    { label: 'natural', fromBody: 'zv-307a', toBody: 'ANT', metrics },
    metrics,
  );
  stub.stubResetWrites();
};
const runCompute = () =>
  computeFtcPlan({ shipRegistration: 'STUB-01', from: 'zv-307a', to: 'ANT', browse: false });

await checkAsync('门控：几何完整 → 输入完整 → 写入滑块一次（best.fuel = 0.15）', async f => {
  stubRoute(stub.stubMetrics());
  const out = await runCompute();
  expectExact(f, 'inputIncomplete', out.inputIncomplete, undefined);
  expectExact(f, 'ok', out.ok, true);
  expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
  expectExact(f, '写入的燃料值', stub.sliderWrites[0]?.value, 0.15);
  // 2026-09-23 起 FTC 参数按**航线**键控（船|起点|终点|gw|nat）：写入键必须与
  // computeFtcPlan 记进 lastFtcCompute.key 的键逐位一致（否则 DEPART/SFC 等待方
  // 按 key 匹配不到本次计算，也读不到滑块值）。
  expectExact(f, '写入的航线键', stub.sliderWrites[0]?.key, 'STUB-01|ZV-307A|ANT|nat');
  expectExact(f, '反应堆写入次数', stub.reactorWrites.length, 1);
  expectExact(f, 'best.fuel', out.best?.fuel, 0.15);
});
await checkAsync('门控：d = undefined → 判定 incomplete → 不写入任何滑块', async f => {
  stubRoute(stub.stubMetrics({ stlDistanceKm: undefined, approachKm: undefined }));
  const out = await runCompute();
  expectCondition(
    f,
    'inputIncomplete 非空',
    (out.inputIncomplete?.length ?? 0) > 0,
    '>0 条',
    '0 条',
  );
  expectCondition(
    f,
    '指向起终点轨道距离',
    out.inputIncomplete?.[0]?.includes('轨道距离') === true,
    '含「轨道距离」',
    String(out.inputIncomplete?.[0]),
  );
  expectExact(f, '滑块写入次数', stub.sliderWrites.length, 0);
  expectExact(f, '反应堆写入次数', stub.reactorWrites.length, 0);
  expectCondition(
    f,
    'message 带警告',
    out.message.includes('未应用到 SFC 滑块'),
    '含警告文案',
    out.message,
  );
});
await checkAsync(
  '门控：跨星系缺罐容量 → 判定 incomplete → 不写入滑块（P2-F 已知局限）',
  async f => {
    stubRoute(stub.stubMetrics({ natPc: 3.2, natJumpCount: 1 }), 0);
    const out = await runCompute();
    expectCondition(
      f,
      'inputIncomplete 非空',
      (out.inputIncomplete?.length ?? 0) > 0,
      '>0 条',
      '0 条',
    );
    expectCondition(
      f,
      '指向罐容量',
      out.inputIncomplete?.includes('STL 罐容量（飞船蓝图性能）') === true,
      '含「罐容量」',
      String(out.inputIncomplete),
    );
    expectExact(f, '滑块写入次数', stub.sliderWrites.length, 0);
  },
);
await checkAsync('门控：跨星系几何完整（有罐容量）→ 不报缺且写入滑块', async f => {
  stubRoute(stub.stubMetrics({ natPc: 3.2, natJumpCount: 1 }));
  const out = await runCompute();
  expectExact(f, 'inputIncomplete', out.inputIncomplete, undefined);
  expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
});

// ---- ⑤ 油罐查表口径：必须按 **store id** 查（getById）----
// 背景（2026-09-25 用户实测 bug）：FTC 面板显示「当前油量：STL 0/0 ｜ FTL 0/0」+ 假缺口
// 警告，而游戏里实际 STL 3,238/3,500、FTL 1,974/2,000。根因：shipFuelRemainingFor 用
// storagesStore.getByAddressableId（键 = 仓库可寻址地址）去查 Ship.stlFuelStoreId
// （store id）—— 键类型不同，永远查不到 → 余量/容量全回退 0，并连带污染
// ShipPerformance.stlRemaining（转移段燃料/速度的乘性基准 0.49×余量×f）与缺口判断。
// 黄金样本 = 用户实测那组数（3,238 / 3,500 与 1,974 / 2,000），字面量写死，禁止从实现反推。
// 替身侧：storagesStore.getById 见 scripts/lib/ftc-node-stub.mjs（stubSetStores 注入）。
const fuelStore = (id, type, weightCapacity, amount) => ({
  id,
  type,
  weightCapacity,
  items: [{ type: 'INVENTORY', quantity: { amount } }],
});
const STL_3238 = fuelStore('stl-1', 'STL_FUEL_STORE', 3500, 3238);
const FTL_1974 = fuelStore('ftl-1', 'FTL_FUEL_STORE', 2000, 1974);

check('油罐查表：stlFuelStoreId/ftlFuelStoreId 有值、idStlFuelStore 为空 → 读到实测余量', f => {
  stub.stubSetStores([STL_3238, FTL_1974]);
  // 故意留 idStlFuelStore / idFtlFuelStore 为空：锁定「优先读 stlFuelStoreId」这条。
  const ship = { ...stub.STUB_SHIP, stlFuelStoreId: 'stl-1', ftlFuelStoreId: 'ftl-1' };
  const r = shipFuelRemainingFor(ship);
  expectExact(f, 'stlRemaining（用户实测 3,238）', r.stlRemaining, 3238);
  expectExact(f, 'ftlRemaining（用户实测 1,974）', r.ftlRemaining, 1974);
  expectExact(f, 'stlCap（用户实测 3,500）', r.stlCap, 3500);
  expectExact(f, 'ftlCap（用户实测 2,000）', r.ftlCap, 2000);
  // 反例保护：旧实现（getByAddressableId，键类型不匹配）在此输入下返回全 0 ——
  // 结果必须不同，否则本用例对「查表键口径」零区分度（docs/contributing.md「同错则恒绿」）。
  expectCondition(
    f,
    '不等于旧 getByAddressableId 行为（全 0）',
    !(r.stlRemaining === 0 && r.ftlRemaining === 0 && r.stlCap === 0 && r.ftlCap === 0),
    '至少一个非 0',
    JSON.stringify(r),
  );
  stub.stubSetStores();
});

check('油罐查表：余量传导到 ShipPerformance.stlRemaining（转移段燃料/速度的乘性基准）', f => {
  stub.stubSetStores([STL_3238, FTL_1974]);
  const ship = { ...stub.STUB_SHIP, stlFuelStoreId: 'stl-1', ftlFuelStoreId: 'ftl-1' };
  const perf = shipPerformanceFor(ship);
  expectExact(f, 'ShipPerformance.stlRemaining', perf.stlRemaining, 3238);
  // 旧实现下余量 0 → shipPerformanceFor 把它落成 undefined（回退蓝图罐容量）→ 燃料基准错。
  expectCondition(
    f,
    '不等于旧行为的 undefined（回落罐容量）',
    perf.stlRemaining !== undefined,
    '3238',
    String(perf.stlRemaining),
  );
  stub.stubSetStores();
});

check('油罐查表：stlFuelStoreId 为空、idStlFuelStore 有值 → 回退分支仍读到余量', f => {
  stub.stubSetStores([STL_3238, FTL_1974]);
  const ship = {
    ...stub.STUB_SHIP,
    stlFuelStoreId: undefined,
    ftlFuelStoreId: undefined,
    idStlFuelStore: 'stl-1',
    idFtlFuelStore: 'ftl-1',
  };
  const r = shipFuelRemainingFor(ship);
  expectExact(f, 'stlRemaining', r.stlRemaining, 3238);
  expectExact(f, 'ftlRemaining', r.ftlRemaining, 1974);
  stub.stubSetStores();
});

check('油罐查表：两个字段都缺 → 余量/容量 0（未停靠或未下发时不得误报）', f => {
  stub.stubSetStores([STL_3238, FTL_1974]);
  const r = shipFuelRemainingFor(stub.STUB_SHIP);
  expectExact(f, 'stlRemaining', r.stlRemaining, 0);
  expectExact(f, 'stlCap', r.stlCap, 0);
  stub.stubSetStores();
});

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
