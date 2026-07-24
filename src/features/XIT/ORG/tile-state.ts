// src/features/XIT/ORG/tile-state.ts
import { createTileStateHook } from '@src/store/user-data-tiles';

export const useOrgTileState = createTileStateHook({
  tab: 'market' as 'market' | 'shipping' | 'published' | 'claimed' | 'publish' | 'board-admin',
});
