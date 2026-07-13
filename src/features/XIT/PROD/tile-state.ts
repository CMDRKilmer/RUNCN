import { createTileStateHook } from '@src/store/user-data-tiles';

export type SortBy = 'capacity' | 'efficiency-asc' | 'efficiency-desc' | 'condition-asc';

export const useTileState = createTileStateHook({
  production: true,
  queue: true,
  inactive: true,
  notQueued: true,
  headers: true,
  expandPlanets: [] as string[],
  expandInfo: [] as string[],
  sortBy: 'capacity' as SortBy,
  lowEff: false,
});
