import { effectScope, ref, watch, watchEffect } from 'vue';
import { userData } from '@src/store/user-data';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { sanitizeActName, isChainPackageName, isChainTrigger } from './chain-identity';
import { createChainSyncController } from './chain-sync';
import { runProgress, normalizeChainRun, deriveChainRun, buildPlanFromPackages } from './chain-run';

function createFleetRuntime() {
  const syncNotice = ref<string>();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const chainSync = createChainSyncController({
    resolveShipName: shipId => {
      const ship = shipsStore.getById(shipId);
      return ship === undefined
        ? undefined
        : sanitizeActName(ship.name ?? ship.registration) || ship.registration;
    },
    onNotice: message => {
      syncNotice.value = message;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        syncNotice.value = undefined;
      }, 8000);
    },
  });
  // Detached scope: closing any tile must not stop state persistence or cancel uploads.
  effectScope(true).run(() => {
    chainSync.start();
    watch(
      () => [
        userData.chainRuns,
        userData.actionPackages.filter(p => isChainPackageName(p.global.name)),
        userData.triggers.filter(isChainTrigger),
      ],
      () => {
        for (const shipId of Object.keys(userData.chainRuns)) {
          chainSync.markDirtyShip(shipId);
        }
      },
      { deep: true },
    );
    // 把推导出的进度状态持久化到 chainRuns：列表全局状态与 ACT/触发器解耦，
    // 删除 ACT 脚本或触发器后，站点与操作内容仍能完整展示。
    watchEffect(() => {
      for (const run of Object.values(userData.chainRuns)) {
        normalizeChainRun(run);
      }
    });

    // 兜底：逆推出的旧版环线记录直接持久化，删除触发器后站点列表不再丢失。
    watchEffect(() => {
      for (const ship of shipsStore.all.value ?? []) {
        if (userData.chainRuns[ship.id] !== undefined) {
          continue;
        }
        const derived = deriveChainRun(ship.id);
        if (derived === undefined) {
          continue;
        }
        const progress = runProgress(derived);
        const finished = progress.finalState === 'done' && progress.done >= progress.total;
        if (!finished) {
          userData.chainRuns[ship.id] = derived;
        }
      }
    });

    // 旧版/导入记录无 plan 快照时，从现有 ACT 包反推并持久化计划载重，
    // 使「载重」列显示阶段载重而不是实时舱载。
    watchEffect(() => {
      for (const run of Object.values(userData.chainRuns)) {
        if (run.plan !== undefined) {
          continue;
        }
        const built = buildPlanFromPackages(run);
        if (built === undefined) {
          continue;
        }
        // 舱容数据未加载前不落盘，等数据就绪后再重建（避免 0 容量占位）。
        if (built.plan.capacity.weight <= 0 && built.plan.capacity.volume <= 0) {
          continue;
        }
        run.plan = built.plan;
        for (let i = 0; i < run.stops.length; i++) {
          const stopPlan = built.stops[i]?.plan;
          if (stopPlan !== undefined) {
            run.stops[i]!.plan = stopPlan;
          }
        }
      }
    });
  });
  return { chainSync, syncNotice };
}
let runtime: ReturnType<typeof createFleetRuntime> | undefined;
export function getFleetRuntime() {
  runtime ??= createFleetRuntime();
  return runtime;
}
