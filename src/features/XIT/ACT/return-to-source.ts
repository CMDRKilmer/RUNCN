// 从 SHP / BRA「生成维修 ACT」登记的目标：购物跑完后把来源飞船界面开回来。
// 登记与认领分开：生成时按包名入队，用户主动发起的那次执行（「执行」或「自动」）
// 才认领并持有；触发器静默执行不认领，不会取走上一次放弃的登记。
// 按包名索引保证别的包的手动执行拿不走本包的目标；同一包连开两条时先进先出。
const EXPIRE_MS = 10 * 60 * 1000;

interface PendingReturn {
  command: string;
  createdAt: number;
}

const pendingReturns = new Map<string, PendingReturn[]>();

export function setReturnCommand(packageName: string, command: string) {
  const entries = pendingReturns.get(packageName) ?? [];
  entries.push({ command, createdAt: Date.now() });
  pendingReturns.set(packageName, entries);
}

/** 按登记顺序取该包的一条；超过有效期的登记视为已放弃，直接丢弃。 */
export function takeReturnCommand(packageName: string): string | undefined {
  const entries = pendingReturns.get(packageName);
  if (entries === undefined) {
    return undefined;
  }
  const now = Date.now();
  for (;;) {
    const entry = entries.shift();
    if (entry === undefined) {
      pendingReturns.delete(packageName);
      return undefined;
    }
    if (now - entry.createdAt <= EXPIRE_MS) {
      return entry.command;
    }
  }
}
