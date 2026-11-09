import type { DispatchBaseConfig, DispatchShip } from './utils';
import { mergeBills } from './utils';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { createId } from '@src/store/create-id';

export interface IncludedBase {
  naturalId: string;
  planetName: string;
  site: PrunApi.Site;
  config: DispatchBaseConfig;
  dispatchShip: DispatchShip;
}

export function buildDispatchActionPlan(
  bases: IncludedBase[],
  bills: Map<string, Record<string, number>>,
  options: { autoLaunch: boolean; autoUnload: boolean },
) {
  const notices: string[] = [];
  const unloadPackages: UserData.ActionPackageData[] = [];
  const triggers: UserData.TriggerData[] = [];
  const groupNameOf = (base: IncludedBase) => base.planetName || base.naturalId;

  const groups: UserData.MaterialGroupData[] = [];
  const cxBuyActions: UserData.ActionData[] = [];
  const exchangeBills = new Map<string, Record<string, number>>();
  const stagedBases: IncludedBase[] = [];

  for (const base of bases) {
    const { naturalId, config, dispatchShip } = base;
    const bill = bills.get(naturalId);
    if (bill === undefined) {
      notices.push(`${base.planetName}: burn 数据未加载，稍后再试`);
      continue;
    }
    if (Object.keys(bill).length === 0) {
      notices.push(`${base.planetName}: 当前库存已满足目标天数，无需补给`);
      continue;
    }

    stagedBases.push(base);

    groups.push({
      type: 'Manual',
      name: groupNameOf(base),
      planet: naturalId,
      materials: bill,
    });

    if (config.cxBuy) {
      const code = dispatchShip.exchangeCode;
      exchangeBills.set(code, mergeBills(exchangeBills.get(code), bill)!);
    }
  }

  if (stagedBases.length === 0) {
    notices.push('所有选中基地当前无需补给或维修');
    return { notices };
  }

  const byShip = new Map<string, IncludedBase[]>();
  for (const base of stagedBases) {
    const shipId = base.config.ship!;
    let list = byShip.get(shipId);
    if (!list) {
      list = [];
      byShip.set(shipId, list);
    }
    list.push(base);
  }

  const multiShipGroups: IncludedBase[][] = [];
  const singleShipBases: IncludedBase[] = [];
  for (const shipBases of byShip.values()) {
    if (shipBases.length >= 2) {
      multiShipGroups.push(shipBases);
    } else {
      singleShipBases.push(shipBases[0]!);
    }
  }

  const mtraActions: UserData.ActionData[] = [];
  const sfcActions: UserData.ActionData[] = [];

  const pushShipMtra = (shipBases: IncludedBase[]) => {
    const first = shipBases[0]!;
    const dispatchShip = first.dispatchShip;
    const shipName = dispatchShip.ship.name ?? dispatchShip.ship.registration;
    const loadName = `装载 ${shipName}`;
    const origin = serializeStorage(dispatchShip.warehouseStore!);
    const dest = serializeStorage(dispatchShip.cargoStore!);

    let materials: Record<string, number> | undefined;
    for (const base of shipBases) {
      const group = groups.find(x => x.name === groupNameOf(base));
      materials = mergeBills(materials, group?.materials);
    }

    groups.push({
      type: 'Manual',
      name: loadName,
      materials: materials!,
    });

    mtraActions.push({ type: 'MTRA', name: loadName, group: loadName, origin, dest });
    sfcActions.push({
      type: 'OPEN SFC',
      name: `卸货 ${shipName}`,
      destination: first.naturalId,
      shipSourceAction: loadName,
    });
    if (options.autoLaunch) {
      sfcActions.push({
        type: 'DEPART',
        name: `出发 ${shipName}`,
        registration: dispatchShip.ship.registration,
      });
    }
  };

  for (const shipBases of multiShipGroups) {
    pushShipMtra(shipBases);
  }

  for (const base of singleShipBases) {
    pushShipMtra([base]);
  }

  for (const [code, materials] of exchangeBills) {
    if (Object.keys(materials).length === 0) {
      continue;
    }
    const groupName = `购买 ${code}`;
    groups.push({
      type: 'Manual',
      name: groupName,
      materials,
    });
    cxBuyActions.push({
      type: 'CX Buy',
      name: groupName,
      group: groupName,
      exchange: code,
      useCXInv: true,
    });
  }

  const pkg: UserData.ActionPackageData = {
    global: { name: '派遣' },
    groups,
    actions: [...cxBuyActions, ...mtraActions, ...sfcActions],
  };

  for (const base of stagedBases) {
    const bill = bills.get(base.naturalId);
    if (!bill) {
      continue;
    }
    const unloadName = `${base.planetName} Unload`;
    const unloadPkg: UserData.ActionPackageData = {
      global: { name: unloadName },
      autoDelete: true,
      groups: [
        {
          type: 'Manual',
          name: 'Unload',
          materials: bill,
        },
      ],
      actions: [
        {
          type: 'MTRA',
          name: 'Unload',
          group: 'Unload',
          origin: configurableValue,
          dest: `${base.planetName || base.naturalId} Base`,
          originType: 'SHIP_STORE',
        },
      ],
    };
    unloadPackages.push(unloadPkg);

    // 到港自动卸货：同步创建一次性触发器，飞船到达该基地时执行上方操作包。
    if (options.autoUnload) {
      const trigger: UserData.TriggerData = {
        id: createId(),
        name: `${base.planetName} 卸货`,
        enabled: true,
        event: {
          type: 'FLIGHT_ENDED',
          ship: base.dispatchShip.ship.registration,
          planet: base.naturalId,
        },
        packageName: unloadName,
        mode: 'CONFIRM',
        cooldownMin: 60,
        createdAt: Date.now(),
        autoDelete: true,
      };
      triggers.push(trigger);
    }
  }
  return { pkg, unloadPackages, triggers, notices };
}
