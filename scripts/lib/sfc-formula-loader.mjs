// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-sfc-formula-plan.mjs。
//
// 目标：在 Node 里驱动**真实的** `src/features/XIT/FTC/formula-compute.ts`
// 与**真实的** `ftc-fuel-settings.ts`（航线键 + 参数写入）。
// 只有这两处走替身：
//   - formula-plan（规划结果由用例脚本控制，公式数值不在此覆盖）
//   - ftc-compute（只为 `lastFtcCompute` 这个共享信号；其余浏览器依赖不参与）
// 未映射的 '@src/*' 会显式报错，避免新增依赖被替身静默吞掉。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTsRelative } from './resolve-ts-relative.mjs';

const STUB = new URL('./sfc-formula-stub.mjs', import.meta.url).href;
const STUBBED = new Set([
  '@src/features/XIT/FTC/formula-plan',
  './formula-plan',
  '@src/features/XIT/FTC/ftc-compute',
  './ftc-compute',
  // ftc-fuel-settings 依赖 vue 的 persistedRef；用最小的 ref 替身保持键/写入逻辑真实。
  '@src/utils/persisted-ref',
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
