// 测试用模块解析替身（Node module.register 钩子），服务
// scripts/verify-ftc-route-key.mjs。
//
// 目标：在 Node 里驱动**真实**的 computeFtcPlan（编排层）+ **真实**的
// ftc-fuel-settings（航线级键 + `.v4` 持久化），只替换浏览器侧依赖：
//   - 'vue'                      → scripts/lib/ftc-vue-ref-stub.mjs
//                                  （persisted-ref 用到的 ref/watch，赋值必须触发 watch）
//   - '@src/utils/persisted-ref' → **真实实现**（要断言的正是持久化键与键空间）
//   - './ftc-fuel-settings'      → **真实实现**（★与 ftc-geometry-loader 的关键差别：
//                                  那里把它换成「只记录写入」的替身，SFC/DEPART 侧读值
//                                  根本不存在，用例断言不到「读不到别的航线的值」；
//                                  这里必须用真实模块，否则断言变空气）
//   - 其余 '@src/*'              → ftc-geometry-stub.mjs（store/orbit/buffers 等替身）
//   - './route-planner' / './route-model' → 真实实现（几何与记录查表逻辑）
//   - './fuel-model'             → ftc-node-fuel-model.mjs（类型位 shim）
const STUB = new URL('./ftc-geometry-stub.mjs', import.meta.url).href;
const VUE = new URL('./ftc-vue-ref-stub.mjs', import.meta.url).href;
const PERSISTED_REF = new URL('../../src/utils/persisted-ref.ts', import.meta.url).href;
const FUEL_SETTINGS = new URL('../../src/features/XIT/FTC/ftc-fuel-settings.ts', import.meta.url)
  .href;
const FUEL_MODEL = new URL('./ftc-node-fuel-model.mjs', import.meta.url).href;
// 生产代码用打包器解析的无扩展名相对导入；Node ESM 需要显式补扩展名。
const REAL = {
  './route-planner': new URL('../../src/features/XIT/FTC/route-planner.ts', import.meta.url).href,
  './route-model': new URL('../../src/features/XIT/FTC/route-model.ts', import.meta.url).href,
};

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'vue') {
    return { url: VUE, format: 'module', shortCircuit: true };
  }
  if (specifier === '@src/utils/persisted-ref') {
    // 不指定 format：让 Node 按 .ts 扩展名走原生类型剥离。
    return { url: PERSISTED_REF, shortCircuit: true };
  }
  if (
    specifier === './ftc-fuel-settings' ||
    specifier === '@src/features/XIT/FTC/ftc-fuel-settings'
  ) {
    return { url: FUEL_SETTINGS, shortCircuit: true };
  }
  if (specifier.startsWith('@src/')) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  if (specifier === './fuel-model') {
    return { url: FUEL_MODEL, format: 'module', shortCircuit: true };
  }
  if (REAL[specifier] !== undefined) {
    return { url: REAL[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
