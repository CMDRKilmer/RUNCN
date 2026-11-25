import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import {
  getDestinationFullName,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
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

export interface DepartTarget {
  /** 交付条款 id：同一合同可能有多条交付条款，用它给按钮做标识。 */
  key: string;
  registration: string | undefined;
  destinationId: string;
  destinationLabel: string;
  ready: boolean;
  hint: string;
  /** 这条交付条款依赖的取货条款 id 集合，CONT 详情里用来把按钮挂到对应的取货行上。 */
  pickupIds: string[];
}

/** shipmentItemId → 载着它的飞船。XIT CONTSS 一次列上百单时用它把遍历摊一次。 */
export type ShipmentShipIndex = ReadonlyMap<string, PrunApi.Ship | undefined>;

export function buildShipmentShipIndex(): ShipmentShipIndex {
  const index = new Map<string, PrunApi.Ship | undefined>();
  for (const store of storagesStore.all.value ?? []) {
    if (store.type !== 'SHIP_STORE') {
      continue;
    }
    const ship = shipsStore.all.value?.find(x => x.idShipStore === store.id);
    for (const item of store.items) {
      if (item.type === 'SHIPMENT' && !index.has(item.id)) {
        index.set(item.id, ship);
      }
    }
  }
  return index;
}

export function findShipForShipment(
  shipmentItemId: string,
  index?: ShipmentShipIndex,
): PrunApi.Ship | undefined {
  if (index !== undefined) {
    return index.get(shipmentItemId);
  }
  // 船上的货物列表才是权威依据：这批货在谁的货舱里，就由谁起飞。
  for (const store of storagesStore.all.value ?? []) {
    if (store.type !== 'SHIP_STORE') {
      continue;
    }
    const carried = store.items.some(x => x.type === 'SHIPMENT' && x.id === shipmentItemId);
    if (!carried) {
      continue;
    }
    const ship = shipsStore.all.value?.find(x => x.idShipStore === store.id);
    if (ship) {
      return ship;
    }
  }
  return undefined;
}

/** 算出该合同当前可以起飞的目标（每条我方负责、未完成的交付条款一条）。 */
export function getDepartTargets(
  contract: PrunApi.Contract,
  index?: ShipmentShipIndex,
): DepartTarget[] {
  const targets: DepartTarget[] = [];
  if (!ACTIVE_STATUSES.has(contract.status)) {
    return targets;
  }
  // 取货条款全部完成才允许起飞。
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
    const ship = findShipForShipment(shipmentItemId, index);
    const registration = ship?.registration;

    // 提示文案要短：气泡最宽 320px，长了会换三四行盖住表格。
    let hint: string;
    if (!pickupsDone) {
      hint = `取货未完成，装完才能起飞 → ${destinationLabel}`;
    } else if (registration === undefined) {
      hint = `没找到载货的飞船 → ${destinationLabel}`;
    } else {
      hint = `${registration} 起飞 → ${destinationLabel}`;
    }

    targets.push({
      key: condition.id,
      registration,
      destinationId,
      destinationLabel,
      ready: pickupsDone && registration !== undefined,
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
