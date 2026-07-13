import { describe, expect, it } from 'vitest';
import { deepFreeze } from './deep-freeze';

describe('deepFreeze', () => {
  it('freezes a flat object', () => {
    const obj = { a: 1, b: 'hello' };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.a).toBe(1);
  });

  it('freezes nested objects recursively', () => {
    const obj = { a: { b: { c: 42 } } };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
  });

  it('freezes arrays and their elements', () => {
    const obj = { arr: [{ x: 1 }, { y: 2 }] };
    const frozen = deepFreeze(obj);
    expect(Object.isFrozen(frozen.arr)).toBe(true);
    expect(Object.isFrozen(frozen.arr[0])).toBe(true);
    expect(Object.isFrozen(frozen.arr[1])).toBe(true);
  });

  it('freezes function-valued properties', () => {
    const fn = () => {};
    const obj = { callback: fn };
    deepFreeze(obj);
    expect(Object.isFrozen(obj.callback)).toBe(true);
  });

  it('is idempotent on already-frozen objects', () => {
    const inner = Object.freeze({ x: 1 });
    const obj = { inner };
    const result = deepFreeze(obj);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.inner)).toBe(true);
    expect(result.inner.x).toBe(1);
  });

  it('returns the same object reference', () => {
    const obj = { a: 1 };
    expect(deepFreeze(obj)).toBe(obj);
  });

  it('handles null and undefined property values gracefully', () => {
    const obj = { a: null, b: undefined, c: 0 };
    expect(() => deepFreeze(obj)).not.toThrow();
    expect(obj.a).toBeNull();
    expect(obj.b).toBeUndefined();
  });
});
