// src/features/XIT/ORG/tile-state.ts
import { createTileStateHook } from '@src/store/user-data-tiles';

export const useOrgTileState = createTileStateHook({
  tab: 'board' as 'board' | 'published' | 'claimed',
});
