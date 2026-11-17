// 测试用模块解析替身，服务 scripts/verify-formula-endpoint.mjs。
// 只替换「地址解析 / 地址行读取 / 星系→空间站反查」三处外部依赖；
// formula-endpoint.ts 的解析顺序、回退与报错逻辑保持真实实现。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTsRelative } from './resolve-ts-relative.mjs';

const STUB = new URL('./formula-endpoint-stub.mjs', import.meta.url).href;
const STUBBED = new Set([
  '@src/infrastructure/prun-api/data/flight-test-collector',
  '@src/infrastructure/prun-api/data/addresses',
  '@src/features/XIT/FTC/route-model',
  './route-model',
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
  }
  const relative = resolveTsRelative(specifier, context);
  if (relative !== undefined) {
    return { url: relative, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
