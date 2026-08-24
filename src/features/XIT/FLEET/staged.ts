export interface StagedDispatch {
  pkg?: UserData.ActionPackageData;
  // 多船并行分段：一次性暂存所有船的主包，FLEETACT 窗口全部渲染，
  // 手动逐个执行；自动模式下按顺序自动执行（DEPART 后飞行阶段并行）。
  pkgs?: UserData.ActionPackageData[];
}

export const stagedDispatch = ref<StagedDispatch | undefined>(undefined);

/** FLEET 主包执行结束信号（成功/失败/取消均触发），用于关闭后台自动执行的隐藏 FLEETACT 窗口。 */
export const dispatchFinished = ref(false);
