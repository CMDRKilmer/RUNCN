import type { ShipChainPlan } from './chain-allocation';
import type { NativeRouteLegPercent, NativeWaypoint } from './native-route-plan';
import type { CheckedRoute } from './native-route-socket';

interface NativeRouteLoopSnapshot {
  cycleHours: number;
  fuel: { stl: number; ftl: number };
  legs: NativeRouteLegPercent[];
}

export interface NativeRouteGeneration {
  candidate: ShipChainPlan;
  initialWaypoints: NativeWaypoint[];
  checkedRoute: CheckedRoute;
  chainName: string;
  // 同一份循环估时驱动装卸计划、备货与航点档位。
  loopPlan?: NativeRouteLoopSnapshot;
}
