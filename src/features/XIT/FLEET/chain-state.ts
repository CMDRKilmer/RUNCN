// 环线阶段完成标记：由 ExecuteActionPackage 在执行成功并删除 autoDelete 包时调用，
// 把完成状态写回持久化的 chainRuns，使执行列表不再依赖 ACT 包/触发器是否仍存在。
import { userData } from '@src/store/user-data';

export function markChainStageDone(packageName: string) {
  for (const run of Object.values(userData.chainRuns)) {
    if (run.mainPkgName === packageName && run.originState !== 'done') {
      run.originState = 'done';
    }
    const stop = run.stops.find(s => s.pkgName === packageName);
    if (stop && stop.state !== 'done') {
      stop.state = 'done';
    }
    if (run.finalPkgName === packageName && run.finalState !== 'done') {
      run.finalState = 'done';
    }
  }
}
