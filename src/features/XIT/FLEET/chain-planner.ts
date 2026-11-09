import { collectChainPlanningSnapshot } from './chain-data';
import { computeChainPlan } from './chain-plan-core';
import { fixed0 } from '@src/utils/format';
import type { ChainRouteInput } from './chain-data';
import type { ChainPlan } from './chain-types';

export function planChainRoute(input: ChainRouteInput): ChainPlan | undefined {
  if (input.capacity.weight <= 0 && input.capacity.volume <= 0) {
    return undefined;
  }
  const snapshot = collectChainPlanningSnapshot(input);
  return snapshot === undefined ? undefined : computeChainPlan(snapshot, fixed0);
}
