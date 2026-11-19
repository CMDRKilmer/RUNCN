// native-route-fuel.ts（原生 RT 逐段燃料编排）在 Node 下的最小测试替身。
//
// 仅服务于 scripts/verify-native-route-settings.mjs：
// scripts/lib/native-route-fuel-loader.mjs 的 resolve 钩子把
// '@src/features/XIT/FTC/ftc-compute' 与 '@src/features/XIT/FTC/formula-plan'
// 以及 './native-route-btf' 重定向到本文件，native-route-plan 保持真实实现。
//
// ⚠️ 明确的局限性（避免误读测试结论）：
//   - planFormulaFlight 替身由用例脚本控制：默认恒失败（inputIncomplete），覆盖的是
//     「stlFuel 初始化 / 档位取整改重算 / 油量不足警告」这段编排逻辑；
//     **不**覆盖公式模型本身（由 verify-ftc-formula.mjs / verify-real-flight.mjs 负责）。
//   - measureNativeRouteFuel 替身恒返回空结果，只记录收到的出发油量参数。
//   - 生产代码**没有**为可测性做任何改动（无注入口、无测试开关）。

let fuelFixture = { stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0 };
// 非 null 时 planFormulaFlight 返回这个最优方案（用例用它覆盖「档位取整改重算」「油量不够」两支）。
let optionFixture = null;
export const ftcCalls = [];
export const btfCalls = [];

export function stubSetFuel(fixture) {
  fuelFixture = fixture;
  optionFixture = null;
  ftcCalls.length = 0;
  btfCalls.length = 0;
}

export function stubSetOption(option) {
  optionFixture = option;
}

// ---- 以下为被替换模块的导出面 ----

// '@src/features/XIT/FTC/ftc-compute'
export const shipFuelRemainingFor = () => fuelFixture;
export const blueprintInfoFor = () => ({
  stlFuelCapacity: 3500,
  minReactorUsage: 0.653,
});

// '@src/features/XIT/FTC/formula-plan'
export const planFormulaFlight = async input => {
  ftcCalls.push({
    stlFuel: input.stlFuel,
    ftlFuel: input.ftlFuel,
    fuel: input.fuel,
    reactor: input.reactor,
  });
  if (optionFixture === null) {
    return {
      ok: false,
      message: 'stub：判缺',
      inputIncomplete: ['stub'],
      reactorRelevant: false,
    };
  }
  return {
    ok: true,
    message: '',
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
