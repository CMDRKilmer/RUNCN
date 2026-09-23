// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-ftc-slider-cache.mjs。
//
// 只替换 'vue'（浏览器侧依赖 → scripts/lib/ftc-vue-ref-stub.mjs），
// `@src/utils/persisted-ref` 指向**真实实现**（Node 解析不了 @src 别名，必须显式映射）——
// 本用例要断言的正是持久化 key 版本升级的生效，替身会掩盖问题。
const VUE = new URL('./ftc-vue-ref-stub.mjs', import.meta.url).href;
const PERSISTED_REF = new URL('../../src/utils/persisted-ref.ts', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'vue') {
    return { url: VUE, format: 'module', shortCircuit: true };
  }
  if (specifier === '@src/utils/persisted-ref') {
    // 不指定 format：让 Node 按 .ts 扩展名走原生类型剥离。
    return { url: PERSISTED_REF, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
