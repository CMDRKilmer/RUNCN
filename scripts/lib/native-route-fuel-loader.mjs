// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-native-route-settings.mjs。
// 只替换 native-route-fuel.ts 的两个有副作用依赖（ftc-compute 编排 / native-route-btf 试飞）；
// fuel-model 与 native-route-plan 保持真实实现。未知依赖不拦截，新增生产依赖会直接报错而不是悄悄成真。
const STUB = new URL('./native-route-fuel-stub.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@src/features/XIT/FTC/ftc-compute') {
    return { url: STUB, shortCircuit: true };
  }
  // fuel-model 是纯函数、保留真实实现；@src 别名 Node 解析不了，必须显式映射。
  if (specifier === '@src/features/XIT/FTC/fuel-model') {
    return {
      url: new URL('../../src/features/XIT/FTC/fuel-model.ts', import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (
    specifier === './native-route-btf' &&
    context.parentURL !== undefined &&
    context.parentURL.endsWith('native-route-fuel.ts')
  ) {
    return { url: STUB, shortCircuit: true };
  }
  // 生产里由 Vite 补扩展名；Node ESM 必须显式拼 .ts。
  if (specifier === './native-route-plan' && !specifier.endsWith('.ts')) {
    return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
