import { userData } from '@src/store/user-data';
import { buildChainActionPackages } from './chain-actions';
import { mintChainFp, sanitizeActName, shipChainScriptScope } from './chain-identity';
import { getActiveChainRuns } from './chain-run';
import { getFleetRuntime } from './chain-runtime';
import type { ShipChainPlan } from './chain-allocation';
import { runStagedPkgs, stageMainPackage } from './chain-execution';
import { stagedDispatch } from './staged';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

function upsertPackage(pkg: UserData.ActionPackageData) {
  const index = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
  if (index >= 0) {
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
}

function upsertTrigger(trigger: UserData.TriggerData) {
  const index = userData.triggers.findIndex(
    x => x.packageName === trigger.packageName && x.event.type === 'FLIGHT_ENDED',
  );
  if (index >= 0) {
    userData.triggers[index] = trigger;
  } else {
    userData.triggers.push(trigger);
  }
}

// 删除指定船的全部环线 ACT 操作包与一次性触发器（含未 autoDelete 的历史残留）。
// 用于「清理计划」按钮（含已完成）与重执行前清理旧脚本。
// shipId 级范围：chainRuns[shipId] 固化包名（改名无关）∪ 未被其它船占用的当前名匹配。
export function removeShipChainScripts(shipId: string, shipName: string) {
  const scope = shipChainScriptScope(shipId, shipName);
  // 保留旧版派遣包的名称匹配。
  const isShipScript = (name: string) => scope.has(name) || name === `环线派遣 ${shipName}`;
  for (let i = userData.actionPackages.length - 1; i >= 0; i--) {
    if (isShipScript(userData.actionPackages[i]!.global.name)) {
      userData.actionPackages.splice(i, 1);
    }
  }
  for (let i = userData.triggers.length - 1; i >= 0; i--) {
    if (isShipScript(userData.triggers[i]!.packageName)) {
      userData.triggers.splice(i, 1);
    }
  }
}

export function executeChainPlans(
  allPlans: ShipChainPlan[],
  options: { autoLaunch: boolean; autoTrigger: boolean },
) {
  const runningIds = new Set(getActiveChainRuns().map(x => x.shipId));
  const plans = allPlans.filter(x => !runningIds.has(x.ship.ship.id));
  if (plans.length === 0) {
    return { plans: [], notice: '所选船只均在执行环线中，无法重复生成。请等待归航或先清理计划。' };
  }
  const executedPlans: ShipChainPlan[] = [];
  let notice: string | undefined;
  const triggerMode: UserData.TriggerMode = options.autoTrigger ? 'AUTO' : 'CONFIRM';
  const mainPkgs: UserData.ActionPackageData[] = [];

  for (const { ship, plan: shipPlan } of plans) {
    // 每艘船 mint 一枚代际指纹：铸入 run 与全部 ACT 包/触发器名——改名无关的归属锚点。
    const fp = mintChainFp();
    const actionPlan = buildChainActionPackages(ship, shipPlan, {
      autoLaunch: options.autoLaunch,
      triggerMode,
      fp,
    });
    if (!actionPlan) {
      continue;
    }
    // 先清掉该船旧版/已完成的环线脚本。
    const shipName =
      sanitizeActName(ship.ship.name ?? ship.ship.registration) || ship.ship.registration;
    removeShipChainScripts(ship.ship.id, shipName);

    // 记录环线运行进度（以船为键），并持久化计划快照：
    // 页面刷新后仍按规划样式显示各阶段操作与「当前阶段载重」。
    const run: UserData.ChainRun = {
      shipId: ship.ship.id,
      shipName: ship.ship.name ?? ship.ship.registration,
      fp,
      startedAt: Date.now(),
      originNaturalId: shipPlan.originNaturalId,
      stops: shipPlan.stops.map((stop, i) => {
        const unloadAt: Record<string, number> = { ...stop.unloadCx };
        for (const [ticker, entry] of stop.unloadChain) {
          unloadAt[ticker] = (unloadAt[ticker] ?? 0) + entry.amount;
        }
        const loadAt: Record<string, number> = {};
        const loadTo: Record<string, string> = {};
        for (const [ticker, entry] of stop.load) {
          loadAt[ticker] = entry.amount;
          loadTo[ticker] = entry.to;
        }
        return {
          naturalId: stop.naturalId,
          planetName: stop.planetName,
          pkgName: actionPlan.stopPkgs[i]!.pkg.global.name,
          // 持久化进度状态：删除 ACT/触发器后列表仍能正确展示。
          state: 'pending',
          plan: {
            unloadAt,
            loadAt,
            loadTo,
            loadOnArrival: stop.loadOnArrival,
            loadOnDeparture: stop.loadOnDeparture,
            clipped: stop.clipped,
          },
        };
      }),
      finalPkgName: actionPlan.finalPkg?.pkg.global.name,
      mainPkgName: actionPlan.mainPkg.global.name,
      originState: 'pending',
      finalState: 'pending',
      plan: {
        capacity: shipPlan.capacity,
        originLoadOnDeparture: shipPlan.loadOnDeparture,
        loadOnReturn: shipPlan.loadOnReturn,
        purchaseBill: shipPlan.purchaseBill,
        originPickup: shipPlan.originPickup,
        finalUnload: shipPlan.finalUnload,
        finalUnloadNotes: shipPlan.finalUnloadNotes,
      },
    };

    userData.chainRuns[ship.ship.id] = run;
    executedPlans.push({ ship, plan: shipPlan });

    // 阶段脚本按序写入 ACT 列表：0 主包 → 1..N 站点包 → N+1 归航包；
    // 操作包保留，成功时仅清理一次性触发器。
    upsertPackage(actionPlan.mainPkg);
    for (const { pkg, trigger } of actionPlan.stopPkgs) {
      upsertPackage(pkg);
      upsertTrigger(trigger);
    }
    if (actionPlan.finalPkg) {
      upsertPackage(actionPlan.finalPkg.pkg);
      upsertTrigger(actionPlan.finalPkg.trigger);
    }
    mainPkgs.push(actionPlan.mainPkg);
  }

  if (mainPkgs.length === 0) {
    return { plans: [], notice: '未生成任何主包（所选船只缺少货舱/仓库）' };
  }
  if (mainPkgs.length === 1) {
    stageMainPackage(mainPkgs[0]!, options.autoTrigger);
  } else {
    // 多船并行分段：全部主包一次性暂存到 FLEETACT（所有船可见可执行），
    // 自动模式下按顺序自动执行；DEPART 后各船独立飞行，飞行阶段并行。
    for (const pkg of mainPkgs) {
      upsertPackage(pkg);
    }
    const stagedPkgs = mainPkgs.map(p => JSON.parse(JSON.stringify(p)));
    stagedDispatch.value = { pkgs: stagedPkgs };
    if (options.autoTrigger) {
      void runStagedPkgs(stagedPkgs);
    } else {
      showBuffer('XIT FLEETACT');
    }
    notice = `已生成 ${mainPkgs.length} 艘船的主包，全部暂存至 FLEETACT 逐艘执行（飞行阶段并行）。`;
  }
  return { plans: executedPlans, notice };
}

export function clearShipChainPlan(shipId: string, shipName: string) {
  const { chainSync } = getFleetRuntime();
  const fp = userData.chainRuns[shipId]?.fp;
  if (fp !== undefined) {
    chainSync.markShipCleared(shipId, fp);
  }
  removeShipChainScripts(shipId, shipName);
  delete userData.chainRuns[shipId];
  chainSync.markDirtyShip(shipId);
}
