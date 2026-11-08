import { userData } from '@src/store/user-data';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { hasPendingTriggerRun } from '@src/features/XIT/ACT/trigger-queue';
import { normalizeChainRun } from './chain-run';

export interface PendingChainStep {
  pkgName: string;
  label: string;
}

// 刷新后脚本一致性校验：chainRuns 中「持久化为未完成」的阶段，其操作包应仍存在。
// 新环线包保留；旧记录无持久化状态时沿用兼容推导。
export function verifyChainRunScript(run: UserData.ChainRun): { ok: boolean; missing: string[] } {
  const pkgExists = (name: string) => userData.actionPackages.some(p => p.global.name === name);
  const missing: string[] = [];
  if (
    run.originState === 'pending' &&
    run.mainPkgName !== undefined &&
    !pkgExists(run.mainPkgName)
  ) {
    missing.push(run.mainPkgName);
  }
  for (const stop of run.stops) {
    if (stop.state === 'pending' && stop.pkgName && !pkgExists(stop.pkgName)) {
      missing.push(stop.pkgName);
    }
  }
  if (
    run.finalState === 'pending' &&
    run.finalPkgName !== undefined &&
    !pkgExists(run.finalPkgName)
  ) {
    missing.push(run.finalPkgName);
  }
  return { ok: missing.length === 0, missing };
}

export function verifyAllChainRuns(): { ok: boolean; diffs: string[] } {
  const diffs: string[] = [];
  for (const run of Object.values(userData.chainRuns)) {
    const { ok, missing } = verifyChainRunScript(run);
    if (!ok) {
      diffs.push(`${run.shipName}：缺失 ${missing.join('、')}`);
    }
  }
  return { ok: diffs.length === 0, diffs };
}

// 扫描全部运行中的环线，找出「船已就位但操作包未执行」的下一阶段。
// includeOrigin=false：刷新自动恢复时不自动执行第 0 步（出发），
// 仅刷新状态显示为「未开始」，出发由用户手动触发。
export function collectPendingChainSteps(includeOrigin = true): PendingChainStep[] {
  const steps: PendingChainStep[] = [];
  for (const run of Object.values(userData.chainRuns)) {
    normalizeChainRun(run);
    const ship = shipsStore.getById(run.shipId);
    if (ship === undefined) {
      continue;
    }
    const dockedAt = ship.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
    const pkgExists = (name: string) => userData.actionPackages.some(p => p.global.name === name);
    // 出发阶段：船仍在出发地、主包未执行（包未被 autoDelete 删除）时执行主包。
    if (
      includeOrigin &&
      run.mainPkgName !== undefined &&
      run.originState !== 'done' &&
      dockedAt === run.originNaturalId &&
      pkgExists(run.mainPkgName) &&
      !hasPendingTriggerRun(run.mainPkgName)
    ) {
      steps.push({ pkgName: run.mainPkgName, label: `${run.shipName} 出发` });
      continue;
    }
    // 站点阶段：取第一个未完成站，若船正停靠该站则执行该站包。
    let allStopsDone = true;
    for (const stop of run.stops) {
      if (stop.state === 'done') {
        continue;
      }
      allStopsDone = false;
      if (
        dockedAt === stop.naturalId &&
        pkgExists(stop.pkgName) &&
        !hasPendingTriggerRun(stop.pkgName)
      ) {
        steps.push({ pkgName: stop.pkgName, label: `${run.shipName} ${stop.planetName}` });
      }
      break;
    }
    // 归航阶段：全部站点完成、船已回出发地且归航包未执行时执行归航包。
    if (
      allStopsDone &&
      run.finalPkgName !== undefined &&
      run.finalState !== 'done' &&
      dockedAt === run.originNaturalId &&
      pkgExists(run.finalPkgName) &&
      !hasPendingTriggerRun(run.finalPkgName)
    ) {
      steps.push({ pkgName: run.finalPkgName, label: `${run.shipName} 归航卸货` });
    }
  }
  return steps;
}
