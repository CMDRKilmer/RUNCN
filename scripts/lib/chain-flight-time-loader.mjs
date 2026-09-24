// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-chain-flight-time.mjs。
//
// 目标：在 Node 里驱动**真实的** `src/features/XIT/FLEET/chain-flight-time.ts`
// （estimateChainFlightTimes —— 环线各段飞行时间），以及它整条链路里除「浏览器侧/编排侧」
// 以外的全部生产实现：
//   chain-flight-time.ts（真实，被测）
//     ├─ @src/.../FTC/route-planner.ts（真实：planRoutes / routeMetrics 的几何来源与查表键）
//     ├─ @src/.../FTC/route-model.ts（真实：resolveSystemId / isSystemId / 空间站反查）
//     ├─ @src/.../FTC/fuel-model.ts（真实，经 shim：纯函数模型）
//     ├─ @src/.../FTC/ftc-compute.ts（真实：shipPerformanceFor / ensureShipBlueprint）
//     ├─ @src/.../FTC/transfer-geometry.ts（真实：A1 几何预测，预测函数的可控输入来自
//     │    systemBodiesStore / predictPosition 替身，见下）
//     └─ @src/.../data/system-bodies.ts（真实，**通过 stub 再导出**：stlSegmentsStore
//          的写入/查表保持真实链路，systemBodiesStore.getPosition 由 stub 提供可注入
//          的观测位置供 transfer-geometry.ts 使用 —— 见 stub 文件头）。
// 只有以下位置被替换：
//   vue / ships / blueprints / storage / buffers / sleep / orbit / routes / stars / stations /
//   flight-plans / ftc-fuel-settings → chain-flight-time-stub.mjs（用例可控的假数据与空实现）
//
// 为什么 system-bodies.ts 走 stub（但保留真实再导出）：A1 路径在系内航线缺前向记录时调
// predictTransferGeometry，它**优先**读 systemBodiesStore.getPosition 作为两端天体的位置
// 观测。该 store 的内容来自过去飞行计划 transferEllipse —— 测试不能去触发真实飞行来
// 填表，于是 stub 提供可注入的 getPosition（同时保留真实 stlSegmentsStore 让本脚本
// 既有的 SHIP_FLIGHT_MISSION 派发断言不变）。这是「真实 store 子集可注入」的标准做法
// （见 docs/contributing.md「写路径与查表路径同错则恒绿」的延伸）。
//
// 局限：未映射的 '@src/*' 会显式报错（而不是静默走替身），避免新增依赖时替身掩盖问题。
const STUB = new URL('./chain-flight-time-stub.mjs', import.meta.url).href;
// fuel-model 的 shim（值 + 类型位混在一个 import 里时 Node 会报缺导出，见该文件注释）。
const FUEL_MODEL = new URL('./chain-flight-time-fuel-model.mjs', import.meta.url).href;

// 走真实实现的模块（显式 URL：Node 解析不了 '@src' 别名；不写 format，让 Node 按 .ts
// 扩展名走原生类型剥离）。
const REAL = {
  '@src/features/XIT/FTC/route-planner': '../../src/features/XIT/FTC/route-planner.ts',
  '@src/features/XIT/FTC/route-model': '../../src/features/XIT/FTC/route-model.ts',
  '@src/features/XIT/FTC/ftc-compute': '../../src/features/XIT/FTC/ftc-compute.ts',
  // A1 几何预测入口：保留真实实现，由 stub 提供可控的输入（位置/恒星/状况）。
  '@src/features/XIT/FTC/transfer-geometry': '../../src/features/XIT/FTC/transfer-geometry.ts',
  '@src/infrastructure/prun-api/data/api-messages':
    '../../src/infrastructure/prun-api/data/api-messages.ts',
  '@src/infrastructure/prun-api/data/addresses':
    '../../src/infrastructure/prun-api/data/addresses.ts',
  './route-planner': '../../src/features/XIT/FTC/route-planner.ts',
  './route-model': '../../src/features/XIT/FTC/route-model.ts',
  // transfer-geometry.ts 内部用 './route-model' / './fuel-model'，二者各自映射。
  './fuel-model': '../../src/features/XIT/FTC/fuel-model.ts',
};

// 走替身的依赖（production 侧的无扩展名相对导入与 @src 别名都要列全）。
const STUBBED = new Set([
  'vue',
  '@src/utils/sleep',
  '@src/infrastructure/prun-api/data/ships',
  '@src/infrastructure/prun-api/data/blueprints',
  '@src/infrastructure/prun-api/data/storage',
  '@src/infrastructure/prun-api/data/stars',
  '@src/infrastructure/prun-api/data/stations',
  '@src/infrastructure/prun-api/data/flight-plans',
  '@src/infrastructure/prun-ui/buffers',
  '@src/infrastructure/fio/orbit',
  '@src/infrastructure/fio/routes',
  // system-bodies 走 stub：stub `export *` 再导出真实的 stlSegmentsStore（保留记录/查表
  // 链路），同时用本地的 systemBodiesStore 提供可控的 getPosition（让 transfer-geometry.ts
  // 在没有真实 FIO 观测的情况下也能被驱动）。这是 A1 路径唯一新增的替身面 —— 见 stub
  // 文件头的解释。
  '@src/infrastructure/prun-api/data/system-bodies',
  './ftc-fuel-settings',
]);

export function resolve(specifier, context, nextResolve) {
  if (specifier === './fuel-model' || specifier === '@src/features/XIT/FTC/fuel-model') {
    return { url: FUEL_MODEL, format: 'module', shortCircuit: true };
  }
  if (STUBBED.has(specifier)) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  if (REAL[specifier] !== undefined) {
    return { url: new URL(REAL[specifier], import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith('@src/')) {
    throw new Error(
      `chain-flight-time-loader: '@src' 依赖未映射 → ${specifier}` +
        '（请显式加入 STUBBED 或 REAL，勿让替身静默吞掉新依赖）',
    );
  }
  return nextResolve(specifier, context);
}
