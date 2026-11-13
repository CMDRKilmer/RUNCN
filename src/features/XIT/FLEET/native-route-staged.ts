import { ref } from 'vue';
import type { ShipChainPlan } from './chain-allocation';
import type { NativeWaypoint } from './native-route-plan';

// FLEET「生成原生 RT」→ 独立窗口（XIT RTWIZ）之间的暂存输入。
export interface StagedNativeRoute {
  candidate: ShipChainPlan;
  waypoints: NativeWaypoint[];
  // 产业链分组名（用作航线名）。
  chainName: string;
  // 首次打开向导时自动跑完燃料计算与写入；向导发 started 后由窗口清掉。
  autoStart?: boolean;
}

export const stagedNativeRoute = ref<StagedNativeRoute | undefined>(undefined);
