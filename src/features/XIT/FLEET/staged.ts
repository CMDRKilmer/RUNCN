export interface StagedDispatch {
  pkg: UserData.ActionPackageData;
}

export const stagedDispatch = ref<StagedDispatch | undefined>(undefined);

/** FLEET 主包执行结束信号（成功/失败/取消均触发），用于关闭后台自动执行的隐藏 FLEETACT 窗口。 */
export const dispatchFinished = ref(false);
