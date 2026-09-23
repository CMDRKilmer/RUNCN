// 测试用模块解析替身（Node module.register 钩子）。
//
// 只为 scripts/verify-ftc-input-consistency.mjs 的「门控集成用例」服务：把生产代码
// ftc-compute.ts 的浏览器侧依赖重定向到 scripts/lib/ftc-node-stub.mjs，从而在不改
// 生产代码、不引入注入点的前提下在 Node 里驱动**真实**的 computeFtcPlan。
// fuel-model.ts 是纯函数（无 import），保留真实实现。
const STUB = new URL('./ftc-node-stub.mjs', import.meta.url).href;

// 仅替换编排层的直连依赖；'./fuel-model' 刻意不在表内（走真实模型），
// 但生产代码用的是无扩展名相对导入（打包器解析）且把 interface 与函数混在一起值导入
// （Node ESM 要求扩展名、类型剥离又不擦除类型名）→ 走一个再导出 shim，见该文件注释。
const LOCAL_DEPS = new Set(['./route-planner', './route-model', './ftc-fuel-settings']);
const FUEL_MODEL = new URL('./ftc-node-fuel-model.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'vue' || specifier.startsWith('@src/') || LOCAL_DEPS.has(specifier)) {
    return { url: STUB, format: 'module', shortCircuit: true };
  }
  if (specifier === './fuel-model') {
    return { url: FUEL_MODEL, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
