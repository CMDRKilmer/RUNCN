import { describe, expect, it } from 'vitest';
import { binarySearch } from './binary-search';

describe('binarySearch', () => {
  const items = [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }, { v: 9 }];
  const sel = (x: { v: number }) => x.v;

  it('returns 0 for empty array', () => {
    expect(binarySearch(5, [], sel)).toBe(0);
  });

  it('returns 0 when value is smaller than all elements', () => {
    expect(binarySearch(0, items, sel)).toBe(0);
  });

  it('returns length when value is larger than all elements', () => {
    expect(binarySearch(10, items, sel)).toBe(5);
  });

  it('returns exact index for a matching value', () => {
    expect(binarySearch(3, items, sel)).toBe(1);
  });

  it('returns first index for a value smaller than the target', () => {
    expect(binarySearch(4, items, sel)).toBe(2);
  });

  it('returns leftmost index for duplicate values', () => {
    const dupes = [{ v: 1 }, { v: 2 }, { v: 2 }, { v: 2 }, { v: 3 }];
    expect(binarySearch(2, dupes, sel)).toBe(1);
  });

  it('handles a single-element array', () => {
    expect(binarySearch(1, [{ v: 1 }], sel)).toBe(0);
    expect(binarySearch(2, [{ v: 1 }], sel)).toBe(1);
    expect(binarySearch(0, [{ v: 1 }], sel)).toBe(0);
  });

  it('returns 0 when value equals first element', () => {
    expect(binarySearch(1, items, sel)).toBe(0);
  });

  it('returns length-1 index when value equals last element', () => {
    expect(binarySearch(9, items, sel)).toBe(4);
  });
});
