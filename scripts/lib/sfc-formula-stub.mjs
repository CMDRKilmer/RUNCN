// SFC 公式联动（formula-compute.ts）在 Node 下的测试替身。
//
// 仅服务 scripts/verify-sfc-formula-plan.mjs：由 sfc-formula-loader.mjs 把
// formula-plan（规划结果）、ftc-compute（lastFtcCompute 共享信号）、persisted-ref（vue 依赖）
// 重定向到本文件。ftc-fuel-settings 与 formula-compute 保持真实实现。
//
// 局限：planFormulaFlightForRegistration 只是按用例脚本回放的桩，覆盖的是「何时写参数」，
// 不覆盖公式数值。

export const calls = [];

let planFixture = undefined;

export const lastFtcCompute = { value: undefined };

export function stubReset() {
  calls.length = 0;
  planFixture = undefined;
  lastFtcCompute.value = undefined;
}

export function stubSetPlan(plan) {
  planFixture = plan;
  calls.length = 0;
}

export function stubSetLastCompute(value) {
  lastFtcCompute.value = value;
}

// '@src/features/XIT/FTC/formula-plan'
export const planFormulaFlightForRegistration = async input => {
  calls.push({ ...input });
  return (
    planFixture ?? {
      ok: false,
      message: 'stub：未设置方案',
      inputIncomplete: ['stub'],
      reactorRelevant: false,
    }
  );
};

// '@src/features/XIT/FTC/ftc-compute'（只用到这个共享信号）
export { lastFtcCompute as lastFtcComputeRef };

// '@src/utils/persisted-ref'：够用的最小 ref（无 vue，无 localStorage 持久化）。
export function persistedRef(_key, initial) {
  return { value: initial };
}
