// 只为 scripts/verify-transit-scan-snapshot.mjs 服务：把 transit-f-scan.ts 的浏览器侧依赖
// 重定向到替身，从而在 Node 里直接驱动**真实**的 blueprintSnapshotOf（纯函数）。
const STUB = new URL('./transit-scan-stub.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (
    specifier === 'vue' ||
    specifier.startsWith('@src/') ||
    specifier === './flight-test-collector' ||
    specifier === './blueprints' ||
    specifier === './ships' ||
    specifier === '../socket-io-middleware' ||
    specifier === './user-data'
  ) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
