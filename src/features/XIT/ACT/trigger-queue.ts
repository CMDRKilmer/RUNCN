import { reactive, ref } from 'vue';
import type { Ref } from 'vue';

// 触发器引擎 → ACT 执行窗口的待执行队列。
// 引擎触发后入队并打开 XIT ACT 窗口，ExecuteActionPackage 监视队列自动开始执行。
interface PendingTriggerRun {
  runId: string;
  triggerId: string;
  packageName: string;
  queuedAt: number;
}

// 队列项有效期：超时未被消费则忽略（避免陈旧触发重复执行）。
const PENDING_EXPIRE_MS = 60_000;

const queue = reactive([] as PendingTriggerRun[]);

export function queueTriggerRun(run: { triggerId: string; packageName: string }) {
  queue.push({
    runId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    queuedAt: Date.now(),
    ...run,
  });
}

export function hasPendingTriggerRun(packageName: string) {
  const now = Date.now();
  return queue.some(x => x.packageName === packageName && now - x.queuedAt < PENDING_EXPIRE_MS);
}

export function consumeTriggerRun(packageName: string) {
  const now = Date.now();
  const index = queue.findIndex(
    x => x.packageName === packageName && now - x.queuedAt < PENDING_EXPIRE_MS,
  );
  return index >= 0 ? queue.splice(index, 1)[0] : undefined;
}

// 按包名索引的完成信号：触发器引擎静默打开 ACT 窗口时，用 autoClose + closeWhen
// 让窗口在包执行结束（成功/失败/取消）后自动关闭，实现后台静默执行。
// 每次触发执行前由引擎重置为 false，执行结束后由 ExecuteActionPackage 置 true。
const finishedByPackage = new Map<string, Ref<boolean>>();

export function getPackageFinished(packageName: string) {
  let signal = finishedByPackage.get(packageName);
  if (!signal) {
    signal = ref(false);
    finishedByPackage.set(packageName, signal);
  }
  return signal;
}
