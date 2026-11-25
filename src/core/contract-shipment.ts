import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import {
  getDestinationFullName,
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import { sleep } from '@src/utils/sleep';

// 「起飞」按钮的共享判定层：货运合同装完货后，打开装货那条船的航行控制（SFC）
// 并把目的地填成合同的卸货地址（绝不自动提交飞行）。
//
// 三个入口共用这一套逻辑，避免出现「列表亮了、详情灰着」：
//   * 原生 CONTS 列表    —— basic/conts-depart-button（DOM 注入）
//   * XIT CONTSS        —— XIT/CONTSS（Vue 渲染）
//   * CONT 合同详情      —— basic/cont-depart-button（DOM 注入到取货条款行）

// 只处理进行中的合同：已取消 / 已终止 / 已完成的合同不提供起飞入口。
const ACTIVE_STATUSES = new Set<PrunApi.ContractStatus>([
  'CLOSED',
  'PARTIALLY_FULFILLED',
  'DEADLINE_EXCEEDED',
]);

/**
 * ready    —— 装完货、船停着，可以起飞
 * loading  —— 取货条款没完成，按钮灰着
 * inFlight —— 货已经上船且船在途：按钮显示「在途」，避免误以为还没起飞
 * noShip   —— 装完了但没找到载货的飞船（可能刚卸货 / 数据未同步）
 */
export type DepartState =
  | 'ready'
  | 'loading'
  | 'inFlight'
  /** 货装完了，但不在船上：落到了某个地面仓库 */
  | 'inStore'
  /** 到处都找不到这批货（已交付 / 数据未同步） */
  | 'missing';

export interface DepartTarget {
  /** 交付条款 id：同一合同可能有多条交付条款，用它给按钮做标识。 */
  key: string;
  registration: string | undefined;
  /** 飞船名（玩家起的名字，如「Virtuosa」）；用来显示，比注册码好认 */
  shipName: string | undefined;
  /** 按钮当前状态，决定按钮文案与是否可点 */
  state: DepartState;
  /** 按钮文案：ready/loading/noShip → 「起飞」；inFlight → 「在途」 */
  label: string;
  destinationId: string;
  destinationLabel: string;
  ready: boolean;
  hint: string;
  /** 这条交付条款依赖的取货条款 id 集合，CONT 详情里用来把按钮挂到对应的取货行上。 */
  pickupIds: string[];
}

export interface ShipmentLocation {
  /** 这批货当前所在的容器：船货舱或某个地面仓库 */
  store: PrunApi.Store;
  /** 当 store 是 SHIP_STORE 时对应的飞船 */
  ship: PrunApi.Ship | undefined;
}

/** shipmentItemId → 所在容器。XIT CONTSS 一次列上百单时用它把遍历摊一次。 */
export type ShipmentIndex = ReadonlyMap<string, ShipmentLocation>;

export function buildShipmentIndex(): ShipmentIndex {
  const index = new Map<string, ShipmentLocation>();
  for (const store of storagesStore.all.value ?? []) {
    const ship =
      store.type === 'SHIP_STORE'
        ? shipsStore.all.value?.find(x => x.idShipStore === store.id)
        : undefined;
    for (const item of store.items) {
      if (item.type === 'SHIPMENT' && !index.has(item.id)) {
        index.set(item.id, { store, ship });
      }
    }
  }
  return index;
}

export function findShipmentLocation(
  shipmentItemId: string,
  index?: ShipmentIndex,
): ShipmentLocation | undefined {
  if (index !== undefined) {
    return index.get(shipmentItemId);
  }
  // 货物所在容器才是权威依据：在船货舱里就是船在运，在仓库里就是还没装船。
  for (const store of storagesStore.all.value ?? []) {
    if (!store.items.some(x => x.type === 'SHIPMENT' && x.id === shipmentItemId)) {
      continue;
    }
    const ship =
      store.type === 'SHIP_STORE'
        ? shipsStore.all.value?.find(x => x.idShipStore === store.id)
        : undefined;
    return { store, ship };
  }
  return undefined;
}

/** 地面仓库的显示名（站点名 + 仓库，仓库名优先）。 */
function describeStore(store: PrunApi.Store): string {
  if (store.type === 'SHIP_STORE') {
    return '船货舱';
  }
  if (store.type === 'WAREHOUSE_STORE') {
    const warehouse = warehousesStore.getById(store.addressableId);
    const name = store.name ?? getDestinationFullName(warehouse?.address ?? undefined);
    return name ? `${name} 仓库` : '仓库';
  }
  const site = sitesStore.getById(store.addressableId);
  const name = site ? getEntityNameFromAddress(site.address) : undefined;
  return name ? `${name} 仓库` : '基地仓库';
}

/** 算出该合同当前可以起飞的目标（每条我方负责、未完成的交付条款一条）。 */
export function getDepartTargets(
  contract: PrunApi.Contract,
  index?: ShipmentIndex,
): DepartTarget[] {
  const targets: DepartTarget[] = [];
  if (!ACTIVE_STATUSES.has(contract.status)) {
    return targets;
  }
  // 起飞闸门是**整单**的：同一合同的货往往装在一条船上，某一批没装完就起飞会
  // 把剩下的货丢下，所以必须等全部取货条款 FULFILLED（用户明确要求）。
  const pickupsDone = contract.conditions
    .filter(x => x.type === 'PICKUP_SHIPMENT')
    .every(x => x.status === 'FULFILLED');

  for (const condition of contract.conditions) {
    if (condition.type !== 'DELIVERY_SHIPMENT') {
      continue;
    }
    // 只认我方负责交付的那条：对方交付的条款轮不到我们起飞。
    if (condition.party !== contract.party) {
      continue;
    }
    if (condition.status === 'FULFILLED') {
      continue;
    }
    const shipmentItemId = condition.shipmentItemId;
    const destination = condition.destination;
    if (!shipmentItemId || !destination) {
      continue;
    }
    const destinationId = getEntityNaturalIdFromAddress(destination);
    if (!destinationId) {
      continue;
    }
    const destinationLabel = getDestinationFullName(destination) ?? destinationId;

    const location = findShipmentLocation(shipmentItemId, index);
    const ship = location?.ship;
    const registration = ship?.registration;
    const shipName = ship?.name;

    // 提示文案要短：气泡最宽 320px，长了会换三四行盖住表格。
    // 船名优先于注册码：AVI-068M5 是内部编号，玩家认得的是船名。
    const shipLabel = shipName ?? registration;
    let state: DepartState;
    let hint: string;
    if (!pickupsDone) {
      state = 'loading';
      hint = `取货未完成，装完才能起飞 → ${destinationLabel}`;
    } else if (location === undefined) {
      // 全表都找不到这批货：多半刚卸完货、交付状态还没刷新。
      state = 'missing';
      hint = `货物不在船上，可能已交付 → ${destinationLabel}`;
    } else if (location.store.type !== 'SHIP_STORE') {
      // 货在某个地面仓库：装船前不能起飞，直接告诉玩家货在哪。
      state = 'inStore';
      hint = `货在 ${describeStore(location.store)}，未装船 → ${destinationLabel}`;
    } else if (ship === undefined) {
      state = 'missing';
      hint = `货物在船货舱但找不到该船 → ${destinationLabel}`;
    } else if (ship.flightId != null) {
      // 货已装船且船在飞：不能再起飞，按钮文案也要跟着改，否则看着像还没起飞。
      state = 'inFlight';
      hint = `${shipLabel} 已在途 → ${destinationLabel}`;
    } else {
      state = 'ready';
      hint = `${shipLabel} 起飞 → ${destinationLabel}`;
    }

    targets.push({
      key: condition.id,
      registration,
      shipName,
      destinationId,
      destinationLabel,
      ready: state === 'ready',
      state,
      label: state === 'inFlight' ? '在途' : '起飞',
      hint,
      pickupIds: [...condition.dependencies],
    });
  }
  return targets;
}

/** 打开（或复用）该船的 SFC 窗口并填入目的地；不提交飞行。 */
export async function openSfcAndFill(
  target: DepartTarget,
): Promise<{ ok: boolean; message?: string }> {
  const registration = target.registration;
  if (registration === undefined) {
    return { ok: false, message: '没找到载货的飞船' };
  }
  const window = await showBuffer(`SFC ${registration}`);
  const container = await waitForAddressContainer(window);
  if (!container) {
    return { ok: false, message: 'SFC 已打开，请手动填目的地' };
  }
  const ok = await selectAddress(container, target.destinationId);
  return ok ? { ok: true } : { ok: false, message: '目的地自动填入失败，请手动选择' };
}

const SFC_WAIT_TIMEOUT_MS = 8000;

async function waitForAddressContainer(root: Element) {
  const deadline = Date.now() + SFC_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const container = _$(root, C.AddressSelector.container);
    if (container) {
      return container;
    }
    await sleep(120);
  }
  return undefined;
}
