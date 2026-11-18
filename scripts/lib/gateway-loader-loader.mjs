// 测试用模块解析替身，服务 scripts/verify-gateway-loader.mjs。
// 只替换 vue / routesStore / buffers / sleep / socket 等外部依赖；网关加载时序逻辑保持真实实现。
//
// 未显式映射的 @src/* **不猜**：猜错路径会让测试静默跑在替身上，所以直接报错。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTsRelative } from './resolve-ts-relative.mjs';

const STUB = new URL('./gateway-loader-stub.mjs', import.meta.url).href;
const STUBBED = new Set([
  'vue',
  '@src/infrastructure/fio/routes',
  '@src/infrastructure/prun-ui/buffers',
  '@src/infrastructure/prun-api/socket-io-middleware',
  '@src/infrastructure/prun-api/data/user-data',
  '@src/utils/sleep',
]);

export function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier)) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  if (specifier.startsWith('@src/')) {
    const ts = new URL('../../src/' + specifier.slice(5) + '.ts', import.meta.url);
    if (existsSync(fileURLToPath(ts))) {
      return { url: ts.href, shortCircuit: true };
    }
    throw new Error(`verify-gateway-loader: 未映射的模块 ${specifier}（在 STUBBED 里显式声明）`);
  }
  const relative = resolveTsRelative(specifier, context);
  if (relative !== undefined) {
    return { url: relative, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
