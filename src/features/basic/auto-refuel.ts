import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userData } from '@src/store/user-data';
import { createFragmentApp } from '@src/utils/vue-fragment-app';
import QuickRefuelDialog from '@src/features/basic/shpf-quick-refuel/QuickRefuelDialog.vue';
import type { RefuelResult } from '@src/features/basic/shpf-quick-refuel/refuel-result';

// 缺油自动加油：停靠 + 燃料低于 95% + 冷却已过 → 静默 QuickRefuel。
const LOW_FUEL = 0.95;
const REFUEL_COOLDOWN = 30_000;
const lastRefuelAttempt = new Map<string, number>();
const refueling = new Set<string>();
// 星球无油（无燃料来源或来源库存不足）而放弃的飞船。
// 记录放弃时的状态指纹，指纹变化（飞船状态改变）前不再尝试。
const noFuelShips = new Set<string>();
const noFuelSignature = new Map<string, string>();

function getFuelRatio(store: PrunApi.Store | undefined) {
  const capacity = store?.weightCapacity;
  if (store == null || capacity == null || capacity <= 0) {
    return undefined;
  }
  return store.weightLoad / capacity;
}

// 飞船状态指纹：飞行、停靠位置、燃料量任一变化即视为"状态发生改变"。
function shipSignature(ship: PrunApi.Ship) {
  const stl = storagesStore.getById(ship.idStlFuelStore);
  const ftl = storagesStore.getById(ship.idFtlFuelStore);
  return [
    ship.flightId ?? '',
    JSON.stringify(ship.address),
    stl?.weightLoad ?? '',
    ftl?.weightLoad ?? '',
  ].join('|');
}

// 当前需要加油的停靠飞船 registration 列表。
const lowFuelShips = computed(() => {
  const ships = shipsStore.all.value;
  if (!ships) {
    return [];
  }
  return ships.flatMap(ship => {
    // 飞行途中不加油
    if (ship.flightId) {
      return [];
    }
    const stlStore = storagesStore.getById(ship.idStlFuelStore);
    const ftlStore = storagesStore.getById(ship.idFtlFuelStore);
    const stlRatio = getFuelRatio(stlStore);
    const ftlRatio = getFuelRatio(ftlStore);
    const isFtlCapable = (ftlStore?.weightCapacity ?? 0) > 0;
    const stlLow = stlRatio !== undefined && stlRatio < LOW_FUEL;
    const ftlLow = isFtlCapable && ftlRatio !== undefined && ftlRatio < LOW_FUEL;
    return stlLow || ftlLow ? [ship.registration] : [];
  });
});

function triggerAutoRefuel(registration: string) {
  const container = document.createElement('div');
  container.style.display = 'none';
  document.body.appendChild(container);
  const fragmentApp = createFragmentApp(QuickRefuelDialog, {
    onResult: (result: RefuelResult) => {
      // 星球无油：放弃后续尝试，直到飞船状态发生改变。
      if (!result.success && result.reason === 'no-fuel') {
        const ship = shipsStore.getByRegistration(registration);
        if (ship) {
          noFuelShips.add(registration);
          noFuelSignature.set(registration, shipSignature(ship));
        }
      }
    },
    onDone: () => {
      refueling.delete(registration);
      fragmentApp.unmount();
      container.remove();
    },
    registration,
    silent: true,
  });
  fragmentApp.appendTo(container);
}

function runDetection() {
  try {
    if (!userData.settings.refuel?.enabled) {
      return;
    }
    const now = Date.now();
    // 当前缺油的飞船集合，用于清理已恢复/已消失飞船的残留标记。
    const lowSet = new Set(lowFuelShips.value);
    // 不再缺油（加满、起飞、售出）的飞船：移除放弃标记与冷却记录，避免本地累积。
    for (const registration of noFuelShips) {
      if (!lowSet.has(registration)) {
        noFuelShips.delete(registration);
        noFuelSignature.delete(registration);
      }
    }
    for (const registration of lastRefuelAttempt.keys()) {
      if (!lowSet.has(registration)) {
        lastRefuelAttempt.delete(registration);
      }
    }
    for (const registration of lowFuelShips.value) {
      // 星球无油已放弃：飞船状态未变则继续跳过。
      if (noFuelShips.has(registration)) {
        const ship = shipsStore.getByRegistration(registration);
        if (ship && shipSignature(ship) === noFuelSignature.get(registration)) {
          continue;
        }
        // 状态已改变，恢复尝试。
        noFuelShips.delete(registration);
        noFuelSignature.delete(registration);
      }
      // 正在加油中不重复
      if (refueling.has(registration)) {
        continue;
      }
      // 冷却期内不重复（处理超时等失败场景）
      if (now - (lastRefuelAttempt.get(registration) ?? 0) < REFUEL_COOLDOWN) {
        continue;
      }
      lastRefuelAttempt.set(registration, now);
      refueling.add(registration);
      triggerAutoRefuel(registration);
    }
  } catch {
    // watcher 吞错，不中断后续检测
  }
}

function init() {
  // 每次打开游戏立即跑一轮检测；之后任何飞船状态（飞行/位置/燃料）变化都重新检测。
  runDetection();
  watch(
    () => shipsStore.all.value?.map(ship => shipSignature(ship)).join('\n') ?? '',
    runDetection,
  );
}

features.add(import.meta.url, init, '缺油自动加油：停靠且燃料低于 95% 时静默加油。');
