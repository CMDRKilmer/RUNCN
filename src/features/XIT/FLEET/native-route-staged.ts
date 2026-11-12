import { ref } from 'vue';
import type { ShipChainPlan } from './chain-allocation';
import type { NativeWaypoint } from './native-route-plan';

// FLEET「生成原生 RT」→ 独立窗口（XIT RTWIZ）之间的暂存输入。
export interface StagedNativeRoute {
  candidate: ShipChainPlan;
  waypoints: NativeWaypoint[];
  // 产业链分组名（用作航线名）。
  chainName: string;
}

export const stagedNativeRoute = ref<StagedNativeRoute | undefined>(undefined);
