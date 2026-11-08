import { computed } from 'vue';
import { stagedDispatch } from './staged';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { queueTriggerRun, getPackageFinished } from '@src/features/XIT/ACT/trigger-queue';
import { watchUntil } from '@src/utils/watch';
import { createId } from '@src/store/create-id';

// 多船自动执行：按顺序触发各主包（FLEETACT 窗口内多个执行实例），
// 前一艘执行完成后再触发下一艘，避免多个 ActionRunner 并发抢占游戏窗口；
// 所有包执行完后自动关闭 FLEETACT 窗口。
export async function runStagedPkgs(pkgs: UserData.ActionPackageData[]) {
  // getPackageFinished 复用已存在的 ref：上次执行留下的 true 会让
  // watchUntil 立即 resolve（并发触发）并让 closeWhen 初始为 true（窗口早关）。
  // 与 trigger-engine 一致，入队前重置为 false。
  for (const pkg of pkgs) {
    getPackageFinished(pkg.global.name).value = false;
  }
  void showBuffer('XIT FLEETACT', {
    force: true,
    autoClose: true,
    closeWhen: computed(() => pkgs.every(p => getPackageFinished(p.global.name).value)),
  });
  for (const pkg of pkgs) {
    queueTriggerRun({ triggerId: createId(), packageName: pkg.global.name });
    await watchUntil(getPackageFinished(pkg.global.name));
  }
}

export function stageMainPackage(pkg: UserData.ActionPackageData, auto: boolean) {
  stagedDispatch.value = { pkg: JSON.parse(JSON.stringify(pkg)) };
  if (auto) {
    getPackageFinished(pkg.global.name).value = false;
    queueTriggerRun({ triggerId: createId(), packageName: pkg.global.name });
    void showBuffer('XIT FLEETACT', {
      force: true,
      autoClose: true,
      closeWhen: computed(() => getPackageFinished(pkg.global.name).value),
    });
  } else {
    showBuffer('XIT FLEETACT');
  }
}

// 静默执行环线操作包：与触发器引擎同通道（入队 + 隐藏窗口自动执行、结束自动关窗）。
export function runChainStepSilently(pkgName: string) {
  const finished = getPackageFinished(pkgName);
  finished.value = false;
  queueTriggerRun({ triggerId: createId(), packageName: pkgName });
  showBuffer(`XIT ACT_${pkgName.replace(' ', '_')}`, {
    force: true,
    autoClose: true,
    closeWhen: computed(() => finished.value),
  });
}
