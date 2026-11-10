import { computed } from 'vue';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

// ── 星球编码 → 该基地要看的船货舱（纯运行时推导，无账号数据）────
// 游戏原生 `SHPI <船应答编码>` 会直接打开该船货舱的可拖动物品网格。
// 船的「应答编码」是 registration（形如 AVI-xxxxx），不是船名：船名可能重复、
// 含中文或空格，不能作为命令参数。
//
// 两类船都要显示：
//   · docked  实际停靠在该星球的船（地址解析出的 naturalId 属于自己的基地，且不在飞行中）；
//   · inbound 正在飞、且 flight.destination 是该星球的船（用 ship.flightId 关联当前飞行）。
// 刻意不读 FLEET 表格「分配」列：那一列只是出发时临时排的船，和当前位置无关。
// 数据随服务端推送实时更新：换账号、改船名、船起降、新建基地都无需配置或
// 发版，代码里也不含任何星球编码或船应答编码。
export type ShipStatus = 'docked' | 'inbound';

export interface BaseShipEntry {
  registration: string;
  status: ShipStatus;
  command: string;
}

function baseNaturalIds(): Set<string> {
  return new Set(
    (sitesStore.all.value ?? [])
      .map(site => getEntityNaturalIdFromAddress(site.address)?.toLowerCase())
      .filter((id): id is string => !!id),
  );
}

// 停靠的船
export const shipsAtBaseMap = computed<Record<string, string[]>>(() => {
  const baseIds = baseNaturalIds();
  const result: Record<string, string[]> = {};
  for (const ship of shipsStore.all.value ?? []) {
    // 飞行中的船 address 为 null，且并不「停靠」在某基地，跳过。
    if (!ship.registration || ship.flightId) {
      continue;
    }
    const id = getEntityNaturalIdFromAddress(ship.address ?? undefined)?.toLowerCase();
    if (!id || !baseIds.has(id)) {
      continue;
    }
    (result[id] ??= []).push(ship.registration);
  }
  return sortRegistrations(result);
});

// 在途、且以该星球为目的地的船。
// 用 ship.flightId 精确关联「当前这一次飞行」，避免把同一个 shipId 的历史
// 航班算进来；aborted 的飞行不算在途。destination 是空间站时解析出的
// naturalId 是空间站编号，不会误匹配到基地星球。
export const inboundShipsAtBaseMap = computed<Record<string, string[]>>(() => {
  const baseIds = baseNaturalIds();
  const flightById = new Map((flightsStore.all.value ?? []).map(flight => [flight.id, flight]));
  const result: Record<string, string[]> = {};
  for (const ship of shipsStore.all.value ?? []) {
    if (!ship.registration || !ship.flightId) {
      continue;
    }
    const flight = flightById.get(ship.flightId);
    if (!flight || flight.aborted) {
      continue;
    }
    const id = getEntityNaturalIdFromAddress(flight.destination)?.toLowerCase();
    if (!id || !baseIds.has(id)) {
      continue;
    }
    (result[id] ??= []).push(ship.registration);
  }
  return sortRegistrations(result);
});

function sortRegistrations(map: Record<string, string[]>) {
  // 同一星球有多艘船时给一个稳定顺序，避免每次重算换来换去。
  for (const list of Object.values(map)) {
    list.sort((a, b) => a.localeCompare(b));
  }
  return map;
}

/**
 * 该基地要显示的舰船货舱列表：停靠的在前、在途的在后，各自按应答编码排序。
 * 没有船（或数据未就绪）时返回空数组，调用方据此隐藏槽位、不开空白窗口。
 */
export function getBaseShipEntries(naturalId?: string | null): BaseShipEntry[] {
  const key = naturalId?.trim().toLowerCase();
  if (!key) {
    return [];
  }
  const entries: BaseShipEntry[] = [];
  const seen = new Set<string>();
  const groups: [string[], ShipStatus][] = [
    [shipsAtBaseMap.value[key] ?? [], 'docked'],
    [inboundShipsAtBaseMap.value[key] ?? [], 'inbound'],
  ];
  for (const [list, status] of groups) {
    for (const registration of list) {
      if (seen.has(registration)) {
        continue;
      }
      seen.add(registration);
      entries.push({ registration, status, command: `SHPI ${registration}` });
    }
  }
  return entries;
}
