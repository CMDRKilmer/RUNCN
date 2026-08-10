import { ref, watch } from 'vue';

/**
 * 与 localStorage 同步的 ref：首次使用取 initial，之后恢复上次保存的值，
 * 后续变更自动写回。
 */
export function persistedRef<T>(key: string, initial: T) {
  let saved: T = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      saved = JSON.parse(raw) as T;
    }
  } catch {
    // 存储损坏时回退到初始值
  }
  const value = ref<T>(saved);
  watch(value, v => {
    if (v === undefined) {
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // 忽略写入失败
    }
  });
  return value;
}
