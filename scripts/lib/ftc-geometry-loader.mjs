// 测试用模块解析替身（Node module.register 钩子）。
//
// 服务 scripts/verify-ftc-geometry-source.mjs：把 route-planner / route-model /
// ftc-compute 的浏览器侧依赖（@src/*、vue）重定向到 scripts/lib/ftc-geometry-stub.mjs，
// 同时把生产代码里无扩展名的相对导入补成真实文件 —— 三个几何/编排模块保留**真实实现**，
// 这样断言的是生产逻辑本身（几何来源选择），而不是替身的复刻。
const STUB = new URL('./ftc-geometry-stub.mjs', import.meta.url).href;
// ftc-compute 从 './fuel-model' 同时值导入函数与 interface（Node 类型剥离不擦类型名）→ 走 shim。
const FUEL_MODEL = new URL('./ftc-node-fuel-model.mjs', import.meta.url).href;
// 生产代码用打包器解析的无扩展名相对导入；Node ESM 需要显式补扩展名。
const REAL = {
  './route-planner': new URL('../../src/features/XIT/FTC/route-planner.ts', import.meta.url).href,
  './route-model': new URL('../../src/features/XIT/FTC/route-model.ts', import.meta.url).href,
};

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'vue' || specifier.startsWith('@src/')) {
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
  return nextResolve(specifier, context);
}
