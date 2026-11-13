// 测试用模块解析替身（Node module.register 钩子）。
//
// 只为 scripts/test-bpc-totals.mjs 服务：把 bp-utils.ts 的浏览器侧依赖
// （@src/infrastructure/prun-api/data/cxob、@src/core/orders）重定向到
// scripts/lib/bpc-node-stub.mjs，从而在 Node 里驱动**真实**的 computeTotals。
const STUB = new URL('./bpc-node-stub.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@src/')) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
