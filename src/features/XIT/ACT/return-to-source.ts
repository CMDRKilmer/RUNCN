// 从 SHP「生成维修 ACT」登记的目标：购物跑完后把来源飞船界面开回来。
// 登记与认领分开：生成时进队列，用户手动点「执行」时由那次执行自己认领并持有。
// 这样两艘船各自生成维修 ACT、或者一次执行还没跑完又生成了新的，都不会互相覆盖；
// 触发器静默跑同一个包时不会去认领，也就不会打开上一次放弃的飞船界面。
const EXPIRE_MS = 10 * 60 * 1000;

interface PendingReturn {
  command: string;
  createdAt: number;
}

const pendingReturns: PendingReturn[] = [];

export function setReturnCommand(command: string) {
  pendingReturns.push({ command, createdAt: Date.now() });
}

/** 按登记顺序取一条；超过有效期的登记视为已放弃，直接丢弃。 */
export function takeReturnCommand(): string | undefined {
  const now = Date.now();
  for (;;) {
    const entry = pendingReturns.shift();
    if (entry === undefined) {
      return undefined;
    }
    if (now - entry.createdAt <= EXPIRE_MS) {
      return entry.command;
    }
  }
}
