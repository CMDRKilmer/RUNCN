// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-native-route-btf.mjs。
//
// 只替换 native-route-btf.ts 的副作用依赖（socket 试飞 / 蓝图 / 地址解析 / FTC / 提示）；
// fuel-model 与 native-route-plan 是纯函数，保留真实实现。未列出的依赖不拦截，
// 生产代码新增依赖会直接报错而不是悄悄成真。
const STUB = new URL('./native-route-btf-stub.mjs', import.meta.url).href;

const STUBBED = new Set([
  '@src/infrastructure/prun-api/data/blueprints',
  '@src/infrastructure/prun-api/data/flight-test-collector',
  '@src/features/XIT/FTC/ftc-compute',
  '@src/features/XIT/FTC/route-planner',
  '@src/utils/sleep',
]);

const REAL = new Map([
  [
    '@src/features/XIT/FTC/fuel-model',
    new URL('../../src/features/XIT/FTC/fuel-model.ts', import.meta.url).href,
  ],
]);

export function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier)) {
    return { url: STUB, shortCircuit: true };
  }
  const real = REAL.get(specifier);
  if (real !== undefined) {
    return { url: real, shortCircuit: true };
  }
  if (
    specifier === './transit-speed-samples' &&
    context.parentURL !== undefined &&
    context.parentURL.endsWith('native-route-btf.ts')
  ) {
    return { url: STUB, shortCircuit: true };
  }
  // 生产里由 Vite 补扩展名；Node ESM 必须显式拼 .ts。
  if (specifier === './native-route-plan' && !specifier.endsWith('.ts')) {
    return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
