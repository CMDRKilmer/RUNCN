// 从 SHP「生成维修 ACT」发起的操作包，跑完后自动把来源飞船界面开回来。
// 只在用户显式点过生成按钮时登记；触发器静默跑同一个包时没有登记，不会误跳。
// 记录用包名作 key：同一时刻同一包只可能由一次生成流程登记，跳回后立即清除。
const returnCommands = new Map<string, string>();

export function setReturnCommand(packageName: string, command: string) {
  returnCommands.set(packageName, command);
}

/** 取出并清除；没有登记或已取过则返回 undefined。 */
export function consumeReturnCommand(packageName: string) {
  const command = returnCommands.get(packageName);
  returnCommands.delete(packageName);
  return command;
}
