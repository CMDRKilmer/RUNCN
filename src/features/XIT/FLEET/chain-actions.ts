import type { DispatchShip } from './utils';
import type { ChainPlan } from './chain-types';
import { sanitizeActName, chainFpSuffix, fitChainPkgName } from './chain-identity';
import { createId } from '@src/store/create-id';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';

// 触发器 + 对应操作包：到港执行本站「卸货→提取→飞往下一站」。
export interface ChainStopPackage {
  pkg: UserData.ActionPackageData;
  trigger: UserData.TriggerData;
}

export interface ChainActionPlan {
  // 出发地主包（暂存至 XIT FLEETACT 执行）。
  mainPkg: UserData.ActionPackageData;
  // 各基地站点包 + 触发器（写入 userData，由 FLIGHT_ENDED 触发）。
  stopPkgs: ChainStopPackage[];
  // 归航包 + 触发器（最终产物卸至出发地仓库，可能为空）。
  finalPkg: ChainStopPackage | undefined;
}

export function buildChainActionPackages(
  ship: DispatchShip,
  plan: ChainPlan,
  options: {
    autoLaunch?: boolean;
    triggerMode?: UserData.TriggerMode;
    // 环线代际指纹：非空时追加到所有包名/触发器名末尾（` <fp>`）。
    fp?: string;
  } = {},
): ChainActionPlan | undefined {
  if (!ship.warehouseStore || !ship.cargoStore) {
    return undefined;
  }
  // 船名净化后仍为空（如中文船名）时回退到注册号，保证包名非空。
  const shipName =
    sanitizeActName(ship.ship.name ?? ship.ship.registration) || ship.ship.registration;
  const fpSuffix = options.fp === undefined ? '' : chainFpSuffix(options.fp);
  const loadGroupName = `装载 ${shipName}`;
  const originWarehouse = serializeStorage(ship.warehouseStore);
  const shipCargo = serializeStorage(ship.cargoStore);

  const actions: UserData.ActionData[] = [];
  const groups: UserData.MaterialGroupData[] = [];

  // 每个有账单的基地一个材料组（与基地规划派遣包一致，便于在 ACT 中查看调整）。
  for (const stop of plan.stops) {
    if (Object.keys(stop.unloadCx).length > 0) {
      groups.push({
        type: 'Manual',
        name: stop.planetName || stop.naturalId,
        planet: stop.naturalId,
        materials: stop.unloadCx,
      });
    }
  }
  // 注：环线模式不再生成加油动作。用户需要加油请在基地规划模式（Plan）操作，
  // 或手动在 ACT 中调整生成的包。

  // 采购：仅合并开启「购买」的基地账单；未开启的基地账单仍会装船（来自仓库库存）。
  if (Object.keys(plan.purchaseBill).length > 0) {
    const buyGroupName = `购买 ${ship.exchangeCode}`;
    groups.push({ type: 'Manual', name: buyGroupName, materials: plan.purchaseBill });
    actions.push({
      type: 'CX Buy',
      name: buyGroupName,
      group: buyGroupName,
      exchange: ship.exchangeCode,
      useCXInv: true,
    });
  }

  groups.push({ type: 'Manual', name: loadGroupName, materials: plan.cxBill });

  actions.push({
    type: 'MTRA',
    name: loadGroupName,
    group: loadGroupName,
    origin: originWarehouse,
    dest: shipCargo,
  });

  const firstStop = plan.stops[0];
  if (firstStop !== undefined) {
    actions.push({
      type: 'OPEN SFC',
      name: `飞往 ${firstStop.planetName}`,
      destination: firstStop.naturalId,
      shipSourceAction: loadGroupName,
    });
    if (options.autoLaunch) {
      actions.push({
        type: 'DEPART',
        name: `出发 ${firstStop.planetName}`,
        registration: ship.ship.registration,
      });
    }
  }

  const mainPkg: UserData.ActionPackageData = {
    global: { name: fitChainPkgName(`0 Chain ${shipName}${fpSuffix}`) },
    // 环线脚本不随执行自动删除：保留完整脚本供状态列表/云端同步/手动清理。
    groups,
    actions,
  };

  const makeTrigger = (name: string, pkgName: string, planet: string): UserData.TriggerData => ({
    id: createId(),
    name,
    enabled: true,
    event: { type: 'FLIGHT_ENDED', ship: ship.ship.registration, planet },
    packageName: pkgName,
    mode: options.triggerMode ?? 'CONFIRM',
    cooldownMin: 60,
    createdAt: Date.now(),
    autoDelete: true,
  });

  const remainingCargo: Record<string, number> = { ...plan.cxBill };
  for (const item of ship.cargoStore.items) {
    if (item.quantity != null) {
      const ticker = item.quantity.material.ticker;
      remainingCargo[ticker] = (remainingCargo[ticker] ?? 0) + item.quantity.amount;
    }
  }
  const remainingAfter = (unload: Record<string, number>, load: Record<string, number> = {}) => {
    for (const [ticker, amount] of Object.entries(unload)) {
      remainingCargo[ticker] = Math.max(0, (remainingCargo[ticker] ?? 0) - amount);
    }
    for (const [ticker, amount] of Object.entries(load)) {
      remainingCargo[ticker] = (remainingCargo[ticker] ?? 0) + amount;
    }
    return Object.fromEntries(
      Object.keys(unload).map(ticker => [ticker, remainingCargo[ticker] ?? 0]),
    );
  };
  const stopPkgs: ChainStopPackage[] = [];
  for (let i = 0; i < plan.stops.length; i++) {
    const stop = plan.stops[i]!;
    // 星球名净化后为空（如中文/含符号名）时回退到 naturalId，保证包名可被 ACT 命令解析。
    const stopLabel = sanitizeActName(stop.planetName || stop.naturalId) || stop.naturalId;
    // 阶段号与进度表「序」列一致：1..N 为各站点。
    const pkgName = fitChainPkgName(`${i + 1} ${stopLabel} Loop ${shipName}${fpSuffix}`);
    const baseStore = `${stop.planetName} Base`;

    const unload: Record<string, number> = { ...stop.unloadCx };
    for (const [ticker, entry] of stop.unloadChain) {
      unload[ticker] = (unload[ticker] ?? 0) + entry.amount;
    }
    const load: Record<string, number> = {};
    for (const [ticker, entry] of stop.load) {
      load[ticker] = entry.amount;
    }

    const next = plan.stops[i + 1];
    const departAction: UserData.ActionData | undefined = options.autoLaunch
      ? {
          type: 'DEPART',
          name: next !== undefined ? `出发 ${next.planetName}` : `出发 ${plan.originNaturalId}`,
          registration: ship.ship.registration,
        }
      : undefined;
    const pkg: UserData.ActionPackageData = {
      global: { name: pkgName },
      groups: [
        { type: 'Manual', name: '卸货', materials: unload },
        { type: 'Manual', name: '提取', materials: load },
      ],
      actions: [
        {
          type: 'MTRA',
          name: '卸货',
          group: '卸货',
          origin: shipCargo,
          dest: baseStore,
        },
        {
          type: 'MTRA',
          name: '提取',
          group: '提取',
          origin: baseStore,
          dest: shipCargo,
        },
        // 保留后续站货物与本站提取，只等待本阶段应卸的数量离舱。
        {
          type: 'Verify Ship Cargo',
          name: '验证卸货',
          registration: ship.ship.registration,
          verifyRemaining: remainingAfter(unload, load),
        },
        {
          type: 'OPEN SFC',
          name: next !== undefined ? `飞往 ${next.planetName}` : `飞往 ${plan.originNaturalId}`,
          destination: next !== undefined ? next.naturalId : plan.originNaturalId,
          shipSourceAction: '提取',
        },
        ...(departAction !== undefined ? [departAction] : []),
      ],
    };
    stopPkgs.push({
      pkg,
      trigger: makeTrigger(`${i + 1} ${stop.planetName} 环线站`, pkgName, stop.naturalId),
    });
  }

  let finalPkg: ChainStopPackage | undefined;
  if (Object.keys(plan.finalUnload).length > 0) {
    const pkgName = fitChainPkgName(`${plan.stops.length + 1} Chain Return ${shipName}${fpSuffix}`);
    finalPkg = {
      pkg: {
        global: { name: pkgName },
        groups: [{ type: 'Manual', name: '卸货', materials: plan.finalUnload }],
        actions: [
          {
            type: 'MTRA',
            name: '卸货',
            group: '卸货',
            origin: shipCargo,
            dest: originWarehouse,
          },
          {
            type: 'Verify Ship Cargo',
            name: '验证归航卸货',
            registration: ship.ship.registration,
            verifyRemaining: remainingAfter(plan.finalUnload),
          },
        ],
      },
      trigger: makeTrigger(
        `${plan.stops.length + 1} ${plan.originNaturalId} 归航卸货`,
        pkgName,
        plan.originNaturalId,
      ),
    };
  }

  return { mainPkg, stopPkgs, finalPkg };
}
