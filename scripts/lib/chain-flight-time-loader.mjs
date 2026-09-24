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
//     └─ @src/.../data/system-bodies.ts（真实：stlSegmentsStore 的记录**写入**与查表口径）
// 只有以下位置被替换：
//   vue / ships / blueprints / storage / buffers / sleep / orbit / routes / stars / stations /
//   flight-plans / ftc-fuel-settings → chain-flight-time-stub.mjs（用例可控的假数据与空实现）
//
// 为什么 system-bodies.ts 保持真实：STL 段记录是「写入键 ↔ 查表键」成对的契约，替身两边
// 都自己写会让两边同错而不被发现（见 docs/contributing.md「写路径与查表路径同错则恒绿」）。
// 夹具因此走**真实** SHIP_FLIGHT_MISSION 消息派发（api-messages.dispatch）写入记录。
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
  '@src/infrastructure/prun-api/data/system-bodies':
    '../../src/infrastructure/prun-api/data/system-bodies.ts',
  '@src/infrastructure/prun-api/data/api-messages':
    '../../src/infrastructure/prun-api/data/api-messages.ts',
  '@src/infrastructure/prun-api/data/addresses':
    '../../src/infrastructure/prun-api/data/addresses.ts',
  './route-planner': '../../src/features/XIT/FTC/route-planner.ts',
  './route-model': '../../src/features/XIT/FTC/route-model.ts',
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
