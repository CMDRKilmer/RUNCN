import { createTileStateHook } from '@src/store/user-data-tiles';
import { computed, type Ref } from 'vue';

export const useBurnTileState = createTileStateHook({
  red: true,
  yellow: true,
  green: true,
  inf: true,
  expand: [] as string[],
  prod: true,
  wf: true,
  io: true,
});

export interface BurnFilters {
  red: boolean;
  yellow: boolean;
  green: boolean;
  inf: boolean;
  prod: boolean;
  wf: boolean;
  io: boolean;
}

export function useBurnFilters(): Ref<BurnFilters> {
  const red = useBurnTileState('red');
  const yellow = useBurnTileState('yellow');
  const green = useBurnTileState('green');
  const inf = useBurnTileState('inf');
  const prod = useBurnTileState('prod');
  const wf = useBurnTileState('wf');
  const io = useBurnTileState('io');

  return computed(() => ({
    red: red.value,
    yellow: yellow.value,
    green: green.value,
    inf: inf.value,
    prod: prod.value,
    wf: wf.value,
    io: io.value,
  }));
}
