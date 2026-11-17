// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-fuel-average.mjs。
//
// 只替换 vue（模块内用到的 ref）；FIO 请求走全局 fetch，由用例脚本注入。
// 均价计算逻辑（FIO 行 → 每市场取价 → 四市场平均 → 缓存）保持真实实现。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTsRelative } from './resolve-ts-relative.mjs';

const STUB = new URL('./fuel-average-stub.mjs', import.meta.url).href;
const STUBBED = new Set(['vue']);

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
