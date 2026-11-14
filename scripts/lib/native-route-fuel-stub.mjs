// native-route-fuel.ts（原生 RT 逐段燃料编排）在 Node 下的最小测试替身。
//
// 仅服务于 scripts/verify-native-route-settings.mjs：
// scripts/lib/native-route-fuel-loader.mjs 的 resolve 钩子把
// '@src/features/XIT/FTC/ftc-compute' 与 './native-route-btf' 重定向到本文件，
// fuel-model / native-route-plan 保留真实实现（纯函数，无浏览器依赖）。
//
// ⚠️ 明确的局限性（避免误读测试结论）：
//   - computeFtcPlan 替身恒失败（inputIncomplete），覆盖的是「stlFuelOverride 初始化」
//     这段编排逻辑——0（真空罐）必须原样透传，不能变成 undefined（回退满罐）；
//     **不**覆盖 FTC 模型本身（由 verify-ftc-*.mjs 负责）。
//   - measureNativeRouteFuel 替身恒返回空结果，只记录收到的出发油量参数；
//     真实 BTF 对 0 油量的处理（试飞全部被拒 → 兜底）不在本脚本范围。
//   - 生产代码**没有**为可测性做任何改动（无注入点、无测试开关）。

let fuelFixture = { stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0 };
// 非 null 时 computeFtcPlan 返回这个最优方案（用例用它覆盖「档位取整改重算」「油量不够」两支）。
let optionFixture = null;
// 离港饱和点只取决于 STL 流量：旧口径会在 10.96×0.0075 ≈ 8% 处砍档，用例据此验证「不再砍」。
let flowRate = 0.5;
export const ftcCalls = [];
export const btfCalls = [];
export const fuelModelCalls = [];

export function stubSetFuel(fixture) {
  fuelFixture = fixture;
  optionFixture = null;
  flowRate = 0.5;
  ftcCalls.length = 0;
  btfCalls.length = 0;
  fuelModelCalls.length = 0;
}

export function stubSetFlowRate(value) {
  flowRate = value;
}

export function stubSetOption(option) {
  optionFixture = option;
}

// ---- 以下为被替换模块的导出面 ----

// '@src/features/XIT/FTC/ftc-compute'
export const shipPerformanceFor = () => ({
  stlFuelFlowRate: flowRate,
  stlFuelCapacity: 3500,
});
export const shipFuelRemainingFor = () => fuelFixture;
export const computeFtcPlan = async input => {
  ftcCalls.push({
    stlFuelOverride: input.stlFuelOverride,
    estimateGeometry: input.estimateGeometry,
    fixedFuel: input.fixedFuel,
    fixedReactor: input.fixedReactor,
  });
  if (optionFixture === null) {
    return { ok: false, message: 'stub：判缺', inputIncomplete: ['stub'] };
  }
  return {
    ok: true,
    message: 'stub',
    best: optionFixture.best,
    reactorRelevant: optionFixture.reactorRelevant,
  };
};

// './native-route-btf'
export const measureNativeRouteFuel = async (
  _candidate,
  _waypoints,
  _legs,
  _signal,
  _onProgress,
  fuel,
) => {
  btfCalls.push({ stlFuel: fuel?.stlFuel, ftlFuel: fuel?.ftlFuel });
  return { legs: new Map(), warnings: [] };
};
