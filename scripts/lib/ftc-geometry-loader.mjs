// 测试用模块解析替身（Node module.register 钩子）。
//
// 服务 scripts/verify-ftc-geometry-source.mjs、verify-ftc-gap-guidance.mjs、
// verify-ftc-gateway-stl.mjs、verify-ftc-station-reverse.mjs：把 route-planner / route-model /
// ftc-compute 的浏览器侧依赖（见 STUBBED_SRC / 'vue'）重定向到 scripts/lib/ftc-geometry-stub.mjs，
// 同时把生产代码里无扩展名的相对导入补成真实文件 —— 三个几何/编排模块保留**真实实现**，
// 这样断言的是生产逻辑本身（几何来源选择），而不是替身的复刻。
//
// '@src/*' 一律查本文件的 REAL_SRC / STUBBED_SRC 映射：命中 REAL_SRC 走真实 .ts，命中
// STUBBED_SRC 走替身，两者都没有就抛错 —— 新增依赖必须在这里显式登记，不能被替身静默吞掉。
import { resolveTsRelative } from './resolve-ts-relative.mjs';

const STUB = new URL('./ftc-geometry-stub.mjs', import.meta.url).href;
// ftc-compute 从 './fuel-model' 同时值导入函数与 interface（Node 类型剥离不擦类型名）→ 走 shim。
const FUEL_MODEL = new URL('./ftc-node-fuel-model.mjs', import.meta.url).href;

// 走真实实现的 '@src/*'（specifier → 相对 src/ 的路径）。
const REAL_SRC = {
  '@src/core/flight/fuel-options': 'core/flight/fuel-options.ts',
  '@src/infrastructure/fio/planet-environment': 'infrastructure/fio/planet-environment.ts',
};

// 走替身的 '@src/*'。替身对其中几个（api-messages / addresses）再导出真实模块，
// 保证用例 dispatch 的合成消息命中的是**同一份**真实记录逻辑。
const STUBBED_SRC = new Set([
  '@src/infrastructure/fio/orbit',
  '@src/infrastructure/fio/routes',
  '@src/infrastructure/prun-api/data/addresses',
  '@src/infrastructure/prun-api/data/api-messages',
  '@src/infrastructure/prun-api/data/blueprints',
  '@src/infrastructure/prun-api/data/flight-plans',
  '@src/infrastructure/prun-api/data/flight-test-collector',
  '@src/infrastructure/prun-api/data/ships',
  '@src/infrastructure/prun-api/data/stars',
  '@src/infrastructure/prun-api/data/stations',
  '@src/infrastructure/prun-api/data/storage',
  '@src/infrastructure/prun-api/data/system-bodies',
  '@src/infrastructure/prun-ui/buffers',
  '@src/utils/sleep',
]);

// 生产代码用打包器解析的无扩展名相对导入；Node ESM 需要显式补扩展名。
const REAL = {
  './route-planner': new URL('../../src/features/XIT/FTC/route-planner.ts', import.meta.url).href,
  './route-model': new URL('../../src/features/XIT/FTC/route-model.ts', import.meta.url).href,
  './transfer-geometry': new URL('../../src/features/XIT/FTC/transfer-geometry.ts', import.meta.url)
    .href,
};

export function resolve(specifier, context, nextResolve) {
  if (STUBBED_SRC.has(specifier)) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  if (specifier.startsWith('@src/')) {
    const target = REAL_SRC[specifier];
    if (target === undefined) {
      throw new Error(
        `未映射的依赖 '${specifier}'（发起模块 ${context.parentURL ?? '未知'}）：` +
          '在 scripts/lib/ftc-geometry-loader.mjs 的 REAL_SRC/STUBBED_SRC 映射里补一条。',
      );
    }
    return { url: new URL('../../src/' + target, import.meta.url).href, shortCircuit: true };
  }
  // vue 的响应式在 Node 下没有对应实现；依赖它的模块整体走替身。
  if (specifier === 'vue') {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  if (specifier === './fuel-model') {
    return { url: FUEL_MODEL, format: 'module', shortCircuit: true };
  }
  if (specifier === './ftc-fuel-settings') {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  if (REAL[specifier] !== undefined) {
    // 不指定 format：让 Node 按扩展名 .ts 走原生类型剥离（显式写 'module' 会当纯 JS 解析）。
    return { url: REAL[specifier], shortCircuit: true };
  }
  const relative = resolveTsRelative(specifier, context);
  if (relative !== undefined) {
    return { url: relative, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
