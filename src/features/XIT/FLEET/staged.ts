import { ref } from 'vue';

export interface StagedDispatch {
  pkg?: UserData.ActionPackageData;
  // 多船并行分段：一次性暂存所有船的主包，FLEETACT 窗口全部渲染，
  // 手动逐个执行；自动模式下按顺序自动执行（DEPART 后飞行阶段并行）。
  pkgs?: UserData.ActionPackageData[];
}

export const stagedDispatch = ref<StagedDispatch | undefined>(undefined);
