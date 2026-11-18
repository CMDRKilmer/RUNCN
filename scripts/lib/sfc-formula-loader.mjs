// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-sfc-formula-plan.mjs。
//
// 目标：在 Node 里驱动**真实的** `src/features/XIT/FTC/formula-compute.ts`
// 与**真实的** `ftc-fuel-settings.ts`（航线键 + 参数写入）。
// 只有这两处走替身：
//   - formula-plan（规划结果由用例脚本控制，公式数值不在此覆盖）
//   - ftc-compute（只为 `lastFtcCompute` 这个共享信号；其余浏览器依赖不参与）
//
// '@src/*' 一律查本文件的 REAL / STUBBED 映射：命中 REAL 走真实 .ts，命中 STUBBED 走替身，
// 两者都没有就抛错 —— 新增依赖必须在这里显式登记，不能被替身静默吞掉。
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolveTsRelative } from './resolve-ts-relative.mjs';

const STUB = new URL('./sfc-formula-stub.mjs', import.meta.url).href;

// 走真实实现的依赖（specifier → 相对 src/ 的路径）。当前没有：本脚本驱动的两个真实模块
// 只依赖下面 STUBBED 里的替身与相对导入。
const REAL = {};

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
    const target = REAL[specifier];
    if (target === undefined) {
      throw new Error(
        `未映射的依赖 '${specifier}'（发起模块 ${context.parentURL ?? '未知'}）：` +
          '在 scripts/lib/sfc-formula-loader.mjs 的 REAL/STUBBED 映射里补一条。',
      );
    }
    return { url: new URL('../../src/' + target, import.meta.url).href, shortCircuit: true };
  }
  const relative = resolveTsRelative(specifier, context);
  if (relative !== undefined) {
    return { url: relative, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
