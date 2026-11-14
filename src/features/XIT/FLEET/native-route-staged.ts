import { ref } from 'vue';
import type { ShipChainPlan } from './chain-allocation';
import type { NativeWaypoint } from './native-route-plan';

// FLEET「生成原生 RT」→ 独立窗口（XIT RTWIZ）之间的暂存输入。
export interface StagedNativeRoute {
  // 每次「生成原生 RT」递增的会话 id：向导用它做 key，重新暂存同一艘船也会重建组件、
  // 清掉上一轮的进度/routeId/航点下标。
  sessionId: number;
  candidate: ShipChainPlan;
  waypoints: NativeWaypoint[];
  // 产业链分组名（用作航线名）。
  chainName: string;
  // 首次打开向导时自动跑完燃料计算与写入；向导发 started 后由窗口清掉。
  autoStart?: boolean;
}

export const stagedNativeRoute = ref<StagedNativeRoute | undefined>(undefined);
