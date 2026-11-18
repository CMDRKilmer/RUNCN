// 燃料均价（src/features/XIT/FTC/fuel-prices.ts）在 Node 下的测试替身。
//
// 只替换 vue（模块内只用到 ref）；FIO 请求由用例脚本通过 globalThis.fetch 注入。
// 取数口径、四市场平均与缓存逻辑保持真实实现。

export function ref(value) {
  return { value };
}

export function computed(fn) {
  return {
    get value() {
      return fn();
    },
  };
}
