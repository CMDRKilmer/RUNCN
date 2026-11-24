import { ref } from 'vue';
import type { ShipChainPlan } from './chain-allocation';
import type { NativeRouteLegPercent, NativeWaypoint } from './native-route-plan';
import type { CheckedRoute } from './native-route-socket';

export interface NativeRouteLoopSnapshot {
  cycleHours: number;
  fuel: { stl: number; ftl: number };
  legs: NativeRouteLegPercent[];
}

// FLEET「生成原生 RT」→ 独立窗口（XIT RTWIZ）之间的暂存输入。
export interface StagedNativeRoute {
  // 每次「生成原生 RT」的会话 id：向导用它做 key，重新暂存同一艘船也会重建组件、
  // 清掉上一轮的进度/routeId/航点下标。
  sessionId: number;
  candidate: ShipChainPlan;
  waypoints: NativeWaypoint[];
  checkedRoute: CheckedRoute;
  // 产业链分组名（用作航线名）。
  chainName: string;
  // 规划中的生成按钮触发一次自动写入，开始后由窗口清掉。
  autoStart?: boolean;
  // 同一份循环估时驱动装卸计划、备货与航点档位。
  loop?: NativeRouteLoopSnapshot;
}

export const stagedNativeRoute = ref<StagedNativeRoute | undefined>(undefined);
