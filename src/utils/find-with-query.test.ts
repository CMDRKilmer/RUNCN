import { describe, expect, it } from 'vitest';
import { findWithQuery } from './find-with-query';

describe('findWithQuery', () => {
  const find = (term: string, _parts: string[]) => {
    const map: Record<string, string> = {
      rat: 'RAT',
      'lom palanka': 'LP',
      dw: 'DW',
    };
    return map[term.toLowerCase()];
  };

  it('returns includeAll for empty query', () => {
    const result = findWithQuery('', find);
    expect(result.includeAll).toBe(true);
    expect(result.excludeAll).toBe(false);
    expect(result.include).toEqual([]);
  });

  it('returns includeAll for whitespace-only query', () => {
    const result = findWithQuery('   ', find);
    expect(result.includeAll).toBe(true);
    expect(result.include).toEqual([]);
  });

  it('matches a single term', () => {
    const result = findWithQuery('rat', find);
    expect(result.include).toEqual(['RAT']);
    expect(result.includeAll).toBe(false);
  });

  it('accumulates multi-word terms until a match', () => {
    // 'lom' has no match, 'palanka' alone has no match,
    // but 'lom palanka' together matches.
    const result = findWithQuery('lom palanka', find);
    expect(result.include).toEqual(['LP']);
    expect(result.includeAll).toBe(false);
  });

  it('matches multiple separate terms', () => {
    const result = findWithQuery('rat dw', find);
    expect(result.include).toEqual(['RAT', 'DW']);
    expect(result.includeAll).toBe(false);
  });

  it('excludes terms after "not" keyword', () => {
    const result = findWithQuery('rat not dw', find);
    expect(result.include).toEqual(['RAT']);
    expect(result.exclude).toEqual(new Set(['DW']));
    expect(result.includeAll).toBe(false);
    expect(result.excludeAll).toBe(false);
  });

  it('sets excludeAll when "not" has no subsequent match', () => {
    const result = findWithQuery('not nonexistent', find);
    expect(result.excludeAll).toBe(true);
    expect(result.exclude).toEqual(new Set());
  });

  it('filters excluded items from include list', () => {
    const result = findWithQuery('rat not rat', find);
    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual(new Set(['RAT']));
  });

  it('is case-insensitive', () => {
    const result = findWithQuery('RAT', find);
    expect(result.include).toEqual(['RAT']);
  });

  it('accepts an array query directly', () => {
    const result = findWithQuery(['rat', 'dw'], find);
    expect(result.include).toEqual(['RAT', 'DW']);
  });

  it('deduplicates when find returns the same item multiple times', () => {
    const alwaysRat = () => 'RAT' as string;
    const result = findWithQuery('rat dw', alwaysRat);
    expect(result.include).toEqual(['RAT']);
  });

  it('accumulates unmatched terms into the next candidate', () => {
    // 'rat' matches, 'nonexistent' accumulates, 'dw' accumulates → 'nonexistent dw' → no match.
    // So only RAT is found; DW is lost because it merged with 'nonexistent'.
    const result = findWithQuery('rat nonexistent dw', find);
    expect(result.include).toEqual(['RAT']);
  });
});
