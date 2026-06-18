/* eslint-disable @typescript-eslint/no-explicit-any */
import { isRef, isReactive, isProxy, toRaw } from 'vue';

export function deepToRaw<T extends Record<string, any>>(sourceObj: T): T {
  const seen = new WeakSet<object>();

  const objectIterator = (input: any): any => {
    if (input === null || input === undefined) {
      return input;
    }
    if (typeof input !== 'object') {
      return input;
    }
    if (input instanceof Date) {
      return input;
    }
    if (isRef(input) || isReactive(input) || isProxy(input)) {
      const raw = toRaw(input);
      if (raw === input) {
        return input;
      }
      return objectIterator(raw);
    }
    if (seen.has(input)) {
      return input;
    }
    // 在递归处理属性前将对象加入 seen，这样循环引用时不会重复处理，
    // 同时确保第一次进入时所有属性被正确 toRaw 转换。
    seen.add(input);
    if (Array.isArray(input)) {
      return input.map(item => objectIterator(item));
    }
    return Object.keys(input).reduce((acc, key) => {
      acc[key as keyof typeof acc] = objectIterator(input[key]);
      return acc;
    }, {} as T);
  };

  return objectIterator(sourceObj);
}
