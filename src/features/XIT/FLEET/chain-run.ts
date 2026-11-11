import { userData } from '@src/store/user-data';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
  getSystemLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { sanitizeActName } from './chain-identity';
import { isChainPackageName } from './chain-identity';
import type { ChainPlan, ChainStopPlan } from './chain-types';
type StopState = UserData.ChainRunStopState;

export interface RunProgress {
  originNaturalId: string;
  stops: { naturalId: string; planetName: string; state: StopState }[];
  done: number;
  total: number;
  originState: StopState;
  finalState: StopState;
}

// 单船各站状态：与执行前一致，沿「origin → 各站 → origin」给出每站进度。
// 新版本将状态持久化到 chainRuns：删除 ACT/触发器后列表仍能展示站点与操作；
// 旧记录（无持久化状态）回退到「包消失 = 完成」的推导。
// 是否已完成（全部站点 + 归航完成）：状态列表据此显示「已完成」标记。
export function isRunFinished(sp: { progress?: RunProgress }): boolean {
  return (
    sp.progress !== undefined &&
    sp.progress.finalState === 'done' &&
    sp.progress.done >= sp.progress.total
  );
}

export function deriveChainRun(shipId: string): UserData.ChainRun | undefined {
  const ship = shipsStore.getById(shipId);
  if (!ship) {
    return undefined;
  }
  const shipName = sanitizeActName(ship.name ?? ship.registration) || ship.registration;
  const stopTriggers = userData.triggers
    .filter(
      t =>
        t.event.type === 'FLIGHT_ENDED' &&
        (t.packageName.endsWith(` Loop ${shipName}`) ||
          t.packageName.endsWith(` 环线 ${shipName}`)),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  if (stopTriggers.length === 0) {
    return undefined;
  }
  const stops = stopTriggers.map(t => {
    const naturalId = t.event.type === 'FLIGHT_ENDED' ? t.event.planet : undefined;
    const site = naturalId ? sitesStore.getByPlanetNaturalId(naturalId) : undefined;
    return {
      naturalId: naturalId ?? '',
      planetName: site
        ? (getEntityNameFromAddress(site.address) ?? naturalId ?? t.packageName)
        : (naturalId ?? t.packageName),
      pkgName: t.packageName,
    };
  });
  const finalTrigger = userData.triggers.find(
    t =>
      t.event.type === 'FLIGHT_ENDED' &&
      (t.packageName.endsWith(`Chain Return ${shipName}`) ||
        t.packageName === `环线归航 ${shipName}`),
  );
  return {
    shipId: ship.id,
    shipName: ship.name ?? ship.registration,
    startedAt: stopTriggers[0]!.createdAt,
    // 归航触发器以出发地为 planet，取它作为出发地标记。
    originNaturalId:
      finalTrigger && finalTrigger.event.type === 'FLIGHT_ENDED'
        ? (finalTrigger.event.planet ?? '')
        : '',
    stops,
    finalPkgName: finalTrigger?.packageName,
  };
}

// 逆推：从操作包还原站点操作清单（无快照时——页面刷新 / 旧版本环线）。
// 已完成站的包已被 autoDelete 删除，无法还原（对应进度「完成」）。
export function deriveStopOps(pkgName: string): {
  unload: Record<string, number>;
  load: Record<string, number>;
} {
  const pkg = userData.actionPackages.find(p => p.global.name === pkgName);
  return {
    unload: pkg?.groups.find(g => g.name === '卸货')?.materials ?? {},
    load: pkg?.groups.find(g => g.name === '提取')?.materials ?? {},
  };
}

// 归航卸货：从归航包（Chain Return 船名）的「卸货」组还原。
export function deriveFinalOps(pkgName: string): Record<string, number> {
  const pkg = userData.actionPackages.find(p => p.global.name === pkgName);
  return pkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
}

// 持久化快照 → 计划对象：页面刷新后仍按规划样式显示阶段操作与载重。
export function chainPlanFromRun(run: UserData.ChainRun): ChainPlan | undefined {
  const snap = run.plan;
  if (snap === undefined) {
    return undefined;
  }
  const stops: ChainStopPlan[] = run.stops.map(s => {
    const unloadAt = s.plan?.unloadAt ?? {};
    const loadAt = s.plan?.loadAt ?? {};
    return {
      naturalId: s.naturalId,
      planetName: s.planetName,
      days: 0,
      cxBuy: false,
      unloadCx: unloadAt,
      unloadChain: new Map(),
      load: new Map(
        Object.entries(loadAt).map(([ticker, amount]) => [
          ticker,
          { amount, to: s.plan?.loadTo?.[ticker] ?? '' },
        ]),
      ),
      returnLoad: {},
      clipped: s.plan?.clipped ?? false,
      loadOnArrival: s.plan?.loadOnArrival ?? { weight: 0, volume: 0 },
      loadOnDeparture: s.plan?.loadOnDeparture ?? { weight: 0, volume: 0 },
    };
  });
  const cxBill: Record<string, number> = { ...snap.purchaseBill };
  for (const [ticker, amount] of Object.entries(snap.originPickup)) {
    cxBill[ticker] = (cxBill[ticker] ?? 0) + amount;
  }
  const loads = [snap.originLoadOnDeparture, ...stops.map(s => s.loadOnDeparture)];
  const peak = loads.reduce(
    (acc, l) => ({
      weight: Math.max(acc.weight, l.weight),
      volume: Math.max(acc.volume, l.volume),
    }),
    { weight: 0, volume: 0 },
  );
  return {
    originNaturalId: run.originNaturalId,
    stops,
    finalUnload: snap.finalUnload,
    cxBill,
    purchaseBill: snap.purchaseBill,
    originPickup: snap.originPickup,
    warnings: [],
    peakLoad: peak,
    freeCapacity: {
      weight: Math.max(0, snap.capacity.weight - peak.weight),
      volume: Math.max(0, snap.capacity.volume - peak.volume),
    },
    capacity: snap.capacity,
    loadOnDeparture: snap.originLoadOnDeparture,
    loadOnReturn: snap.loadOnReturn,
    overCapacity: false,
    finalUnloadNotes: snap.finalUnloadNotes,
  };
}

// 计算一批材料的重量/体积（用于从旧 ACT 包还原阶段载重）。
function materialsLoad(record: Record<string, number>) {
  let weight = 0;
  let volume = 0;
  for (const [ticker, amount] of Object.entries(record)) {
    const mat = materialsStore.getByTicker(ticker);
    if (mat) {
      weight += mat.weight * amount;
      volume += mat.volume * amount;
    }
  }
  return { weight, volume };
}

// ── 主包解析（取代按船名切片反推）──────────────────────────
// 旧版/无 plan 快照的 run 需从 ACT 包反推采购/装载。主包定位优先级：
// 1) run.mainPkgName 精确匹配（execute 固化、改名无关）；
// 2) run 带代际指纹时按 `0 Chain … <fp>` 定位（改名后仍准确）；
// 3) 古早记录（两者皆无）才回退「Loop <船名>」切船名后缀匹配。
function findRunMainPkg(run: UserData.ChainRun): UserData.ActionPackageData | undefined {
  if (run.mainPkgName !== undefined) {
    const pkg = userData.actionPackages.find(p => p.global.name === run.mainPkgName);
    if (pkg) {
      return pkg;
    }
  }
  if (run.fp !== undefined) {
    const suffix = ` ${run.fp}`;
    const pkg = userData.actionPackages.find(
      p =>
        isChainPackageName(p.global.name) &&
        p.global.name.startsWith('0 Chain') &&
        p.global.name.endsWith(suffix),
    );
    if (pkg) {
      return pkg;
    }
  }
  const firstPkgName = run.stops[0]?.pkgName ?? '';
  const idx = firstPkgName.lastIndexOf(' Loop ');
  if (idx < 0) {
    return undefined;
  }
  const shipName = firstPkgName.slice(idx + ' Loop '.length);
  return userData.actionPackages.find(p => p.global.name.endsWith(`Chain ${shipName}`));
}

// 旧版/导入的环线记录没有 plan 快照时，从现有 ACT 包（主包/站点包/归航包）
// 反推一份计划载重快照，让「载重」列显示阶段载重而非实时舱载。
export function buildPlanFromPackages(
  run: UserData.ChainRun,
): { plan: UserData.ChainRunPlan; stops: UserData.ChainRunStop[] } | undefined {
  const mainPkg = findRunMainPkg(run);
  const buyGroup = mainPkg?.groups.find(g => (g.name ?? '').startsWith('购买 '));
  const loadGroup = mainPkg?.groups.find(g => (g.name ?? '').startsWith('装载 '));
  const purchaseBill = buyGroup?.materials ?? {};
  const cxBill = loadGroup?.materials ?? {};
  const originPickup: Record<string, number> = {};
  for (const [ticker, amount] of Object.entries(cxBill)) {
    const pickup = amount - (purchaseBill[ticker] ?? 0);
    if (pickup > 0) {
      originPickup[ticker] = pickup;
    }
  }
  const finalPkg = run.finalPkgName
    ? userData.actionPackages.find(p => p.global.name === run.finalPkgName)
    : undefined;
  const finalUnload = finalPkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
  // 旧版单船主包未写入 ACT 列表：用站点包「卸货」之和近似原始装载量。
  const fallbackBill: Record<string, number> = {};
  if (Object.keys(cxBill).length === 0) {
    for (const stop of run.stops) {
      const pkg = userData.actionPackages.find(p => p.global.name === stop.pkgName);
      const unload = pkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
      for (const [ticker, amount] of Object.entries(unload)) {
        fallbackBill[ticker] = (fallbackBill[ticker] ?? 0) + amount;
      }
    }
    for (const [ticker, amount] of Object.entries(finalUnload)) {
      fallbackBill[ticker] = (fallbackBill[ticker] ?? 0) + amount;
    }
  }
  const originBill = Object.keys(cxBill).length > 0 ? cxBill : fallbackBill;
  const ship = shipsStore.getById(run.shipId);
  const cargo = ship ? storagesStore.getById(ship.idShipStore) : undefined;
  const capacity = cargo
    ? { weight: cargo.weightCapacity, volume: cargo.volumeCapacity }
    : { weight: 0, volume: 0 };
  let current = materialsLoad(originBill);
  const stops: UserData.ChainRunStop[] = run.stops.map((stop, i) => {
    if (stop.plan !== undefined) {
      return stop;
    }
    const pkg = userData.actionPackages.find(p => p.global.name === stop.pkgName);
    const unload = pkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
    const load = pkg?.groups.find(g => g.name === '提取')?.materials ?? {};
    const unloadLoad = materialsLoad(unload);
    const loadLoad = materialsLoad(load);
    const next = run.stops[i + 1]?.planetName ?? run.originNaturalId;
    const loadOnArrival = {
      weight: Math.max(0, current.weight - unloadLoad.weight),
      volume: Math.max(0, current.volume - unloadLoad.volume),
    };
    current = {
      weight: loadOnArrival.weight + loadLoad.weight,
      volume: loadOnArrival.volume + loadLoad.volume,
    };
    const loadTo: Record<string, string> = {};
    for (const ticker of Object.keys(load)) {
      loadTo[ticker] = next;
    }
    return {
      ...stop,
      plan: {
        unloadAt: unload,
        loadAt: load,
        loadTo,
        loadOnArrival,
        loadOnDeparture: current,
        clipped: false,
      },
    };
  });
  return {
    plan: {
      capacity,
      originLoadOnDeparture: materialsLoad(originBill),
      loadOnReturn: current,
      purchaseBill,
      originPickup,
      finalUnload,
    },
    stops,
  };
}

// 出发行采购：从主包（Chain 船名）的「购买」组还原。
// 主包定位走 findRunMainPkg（mainPkgName / 代际指纹优先），不再切船名。
export function derivePurchaseBill(run: UserData.ChainRun): Record<string, number> {
  const mainPkg = findRunMainPkg(run);
  return mainPkg?.groups.find(g => (g.name ?? '').startsWith('购买 '))?.materials ?? {};
}

function stationSystemOf(naturalId: string): string | undefined {
  const station = stationsStore.getByNaturalId(naturalId);
  if (!station) {
    return undefined;
  }
  return getSystemLineFromAddress(station.address)?.entity.naturalId;
}

export function runProgress(run: UserData.ChainRun): RunProgress {
  const ship = shipsStore.getById(run.shipId);
  const flight = ship?.flightId ? flightsStore.getById(ship.flightId) : undefined;
  const flightDest = flight ? getEntityNaturalIdFromAddress(flight.destination) : undefined;
  const dockedAt = ship?.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
  // 环线按序执行：船已通过（停靠或飞行途中的目标站）之前的所有站必然已执行完成。
  // 中断恢复后船可能已在途（正飞往后续站），上一站状态可能未持久化为 done——
  // 按停靠位置（dockedAt）或飞行目的站（flightDest）前推为完成。
  const stopIndexAt = (id: string | undefined) =>
    id === undefined ? -1 : run.stops.findIndex(s => s.naturalId === id);
  const dockedStopIndex = stopIndexAt(dockedAt);
  // 归航在途：飞行目的地是出发地（空间站地址可能被规范化为系统，按归属系统比较）。
  const homeward =
    flightDest !== undefined &&
    (flightDest.toUpperCase() === run.originNaturalId.toUpperCase() ||
      (stationSystemOf(run.originNaturalId) ?? '').toUpperCase() === flightDest.toUpperCase());
  // 已通过前缀终点（不含该站本身）：停靠站 > 在途目的站 > 归航（全部站）。
  const passedUpTo =
    dockedStopIndex >= 0 ? dockedStopIndex : homeward ? run.stops.length : stopIndexAt(flightDest);
  const stops = run.stops.map((stop, i) => {
    const pkgExists = userData.actionPackages.some(p => p.global.name === stop.pkgName);
    const fired = (userData.triggers.find(t => t.packageName === stop.pkgName)?.runCount ?? 0) > 0;
    let state: StopState;
    if (stop.state === 'done' || (passedUpTo >= 0 && i < passedUpTo)) {
      state = 'done';
    } else if (dockedAt === stop.naturalId || (pkgExists && fired)) {
      state = 'arrived';
    } else if (flightDest === stop.naturalId) {
      state = 'transit';
    } else if (stop.state !== undefined) {
      // 持久化状态优先：删除 ACT/触发器不会把未完成站误判为「完成」。
      state = stop.state;
    } else if (!pkgExists) {
      state = 'done';
    } else {
      state = 'pending';
    }
    return { naturalId: stop.naturalId, planetName: stop.planetName, state };
  });
  const done = stops.filter(s => s.state === 'done').length;
  const allStopsDone = stops.every(s => s.state === 'done');
  const originState: StopState =
    run.originState === 'done' || (stops.length > 0 && stops[0]!.state !== 'pending')
      ? 'done'
      : 'pending';
  const finalPkgExists =
    run.finalPkgName !== undefined &&
    userData.actionPackages.some(p => p.global.name === run.finalPkgName);
  let finalState: StopState;
  if (run.finalState === 'done') {
    finalState = 'done';
  } else if (allStopsDone) {
    if (dockedAt === run.originNaturalId) {
      // 新记录保留持久化状态（避免删除归航包被误判完成）；旧记录按原逻辑处理。
      finalState = run.finalState === undefined ? (finalPkgExists ? 'arrived' : 'done') : 'arrived';
    } else if (homeward) {
      // 归航在途：目的地为出发地（空间站地址可能被规范化为系统）。
      finalState = 'transit';
    } else {
      finalState = run.finalState ?? 'pending';
    }
  } else {
    finalState = run.finalState ?? 'pending';
  }
  return {
    originNaturalId: run.originNaturalId,
    stops,
    done,
    total: stops.length,
    originState,
    finalState,
  };
}

export function normalizeChainRun(run: UserData.ChainRun) {
  const progress = runProgress(run);
  run.originState = progress.originState;
  run.finalState = progress.finalState;
  for (let i = 0; i < run.stops.length; i++) {
    run.stops[i].state = progress.stops[i].state;
  }
}

export function getActiveChainRuns() {
  const result: { shipId: string; run: UserData.ChainRun; progress: RunProgress }[] = [];
  // 主：执行中的环线记录。不限于「可分配船只」——船 DEPART 后离开空间站，
  // 已不在 ships props / eligibleShips 中，只要船仍存在就持续显示进度。
  for (const run of Object.values(userData.chainRuns)) {
    if (shipsStore.getById(run.shipId) === undefined) {
      continue;
    }
    result.push({ shipId: run.shipId, run, progress: runProgress(run) });
  }
  // 兜底：从触发器推导环线（旧版本执行 / chainRuns 记录丢失时）。
  // 遍历全部船而非仅选中船——执行中的船已不在 CX，selectedShips 为空。
  for (const ship of shipsStore.all.value ?? []) {
    if (result.some(x => x.shipId === ship.id)) {
      continue;
    }
    const run = deriveChainRun(ship.id);
    if (run === undefined) {
      continue;
    }
    const progress = runProgress(run);
    // 全部站点与归航包都完成后视为已结束，不再显示（避免占用进度区）。
    if (progress.done >= progress.total) {
      const finalDone =
        run.finalPkgName === undefined ||
        !userData.actionPackages.some(p => p.global.name === run.finalPkgName);
      if (finalDone) {
        continue;
      }
    }
    result.push({ shipId: ship.id, run, progress });
  }
  return result;
}

export function pruneOrphanChainRuns() {
  for (const [shipId, run] of Object.entries(userData.chainRuns)) {
    const progress = runProgress(run);
    const hasAnyScript =
      (run.mainPkgName !== undefined &&
        (userData.actionPackages.some(p => p.global.name === run.mainPkgName) ||
          userData.triggers.some(t => t.packageName === run.mainPkgName))) ||
      run.stops.some(
        s =>
          userData.actionPackages.some(p => p.global.name === s.pkgName) ||
          userData.triggers.some(t => t.packageName === s.pkgName),
      ) ||
      (run.finalPkgName !== undefined &&
        (userData.actionPackages.some(p => p.global.name === run.finalPkgName) ||
          userData.triggers.some(t => t.packageName === run.finalPkgName)));
    if (!hasAnyScript) {
      // 正常完成的运行保留展示（状态列表显示「完成」）；孤立的预留列表立即移除。
      const completedNewRun =
        run.mainPkgName !== undefined &&
        run.originState === 'done' &&
        run.finalState === 'done' &&
        progress.done >= progress.total;
      if (completedNewRun) {
        continue;
      }
      delete userData.chainRuns[shipId];
      continue;
    }
  }
}
