// 'vue' 的最小替身（只服务 scripts/verify-ftc-slider-cache.mjs）。
//
// 只实现 persisted-ref.ts 用到的 ref / watch，但**赋值必须触发 watch** —— 真实 vue 的
// ref 是响应式的；若用普通 { value } 对象，persisted-ref 的「变更 → 写 localStorage」
// 路径就断掉，用例也就断言不到「新值仍能正常读写」。
export function ref(value) {
  const watchers = [];
  return {
    get value() {
      return value;
    },
    set value(next) {
      value = next;
      for (const watcher of watchers) {
        watcher(next);
      }
    },
    __watch(callback) {
      watchers.push(callback);
    },
  };
}

export function watch(source, callback) {
  if (source !== undefined && source !== null && typeof source.__watch === 'function') {
    source.__watch(callback);
  }
}
