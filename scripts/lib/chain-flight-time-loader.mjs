// 测试用模块解析替身（Node module.register 钩子），服务 scripts/verify-chain-flight-time.mjs。
//
// 目标：在 Node 里驱动**真实的** `src/features/XIT/FLEET/chain-flight-time.ts` 与它下面的
// 真实公式链路（formula-plan → formula-options → flight-formula → core/flight）。
// 只有「浏览器侧 / 游戏侧」依赖走替身（见 STUBBED）：
//   - store：ships / blueprints / 油缸读数（ship-fuel）
//   - 世界时钟：fio/orbit 的 gameNow
//   - 地址与星图快照：formula-inputs 的 loadFormulaInputs（真实实现会向游戏发 NOMENCLATURE
//     查询并读 route/stars store，脚本里改为直接注入 FlightInputs）
//
// 局限：本脚本覆盖的是「环线编排 + 与真实公式模型接线」，不覆盖公式数值本身
// （数值由 verify-ftc-formula.mjs / verify-real-flight.mjs 负责），也不覆盖滑块写入
// （chain-flight-time.ts 从不写滑块，写入面在 FTC / SFC）。
// 未映射的 '@src/*' 会显式报错，避免新增依赖被替身静默吞掉。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUB = new URL('./chain-flight-time-stub.mjs', import.meta.url).href;

// 走替身的依赖（模块内的所有导出都由 chain-flight-time-stub.mjs 提供）。
const STUBBED = new Set([
  '@src/infrastructure/fio/orbit',
  '@src/infrastructure/prun-api/data/ships',
  '@src/infrastructure/prun-api/data/blueprints',
  '@src/features/XIT/FTC/ship-fuel',
  '@src/features/XIT/FTC/formula-inputs',
  '@src/utils/sleep',
  './ship-fuel',
  './formula-inputs',
]);

export function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier)) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  const base = specifier.startsWith('@src/')
    ? new URL('../../src/' + specifier.slice(5), import.meta.url)
    : specifier.startsWith('.') && context.parentURL !== undefined
      ? new URL(specifier, context.parentURL)
      : undefined;
  if (base !== undefined) {
    const ts = base.href.endsWith('.ts') ? base.href : `${base.href}.ts`;
    if (existsSync(fileURLToPath(ts))) {
      return { url: ts, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
