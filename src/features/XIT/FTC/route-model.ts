import { starsStore, getStarNaturalId } from '@src/infrastructure/prun-api/data/stars';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { getStationSystem, getStationsInSystem } from '@src/infrastructure/fio/orbit';
import {
  getSystemLineFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';

// 航线几何基础（XIT FTC 燃料计算器使用）。
// 提供起终点解析、恒星坐标位置与三维距离；航线规划与燃料模型见
// route-planner.ts / fuel-model.ts。

// 将任意航点 naturalId 解析为所属星系 id：恒星级 id 直接命中，
// 空间站查其地址的 SYSTEM 行，行星去掉一颗卫星后缀，卫星再剥离
// 小写字母开头的后缀。空间站 → 星系映射优先查内置数据（FIO 无空间站
// 数据，离线可用），其次游戏内 stationsStore（defaultStations + 访问过的站）。
export function resolveSystemId(naturalId: string): string | undefined {
  const upper = naturalId.trim().toUpperCase();
  if (upper === '') {
    return undefined;
  }
  const star = starsStore.getByNaturalId(upper);
  if (star) {
    return getStarNaturalId(star);
  }
  const bundledSystem = getStationSystem(upper);
  if (bundledSystem !== undefined) {
    return bundledSystem;
  }
  const station = stationsStore.getByNaturalId(upper);
  const systemLine = station ? getSystemLineFromAddress(station.address) : undefined;
  if (systemLine) {
    return systemLine.entity.naturalId;
  }
  const byPlanet = starsStore.getByPlanetNaturalId(upper);
  if (byPlanet) {
    return getStarNaturalId(byPlanet);
  }
  const stripped = upper.replace(/[a-z][a-z0-9]*$/, '');
  if (stripped !== upper) {
    const moonStar = starsStore.getByNaturalId(stripped);
    if (moonStar) {
      return getStarNaturalId(moonStar);
    }
  }
  return undefined;
}

// 该 naturalId 本身是否就是一个星系（恒星）id（如 ZV-307），而不是天体/空间站
// （如 ZV-307a / ANT）。用途：区分「终点是具体天体」与「终点是星系」——
// SFC 的目的地输入框会把**空间站目的地规范化成所属星系 id**（见
// prun-ui/utils/select-address.ts 与 FLEET/ChainView.vue 的注释），此时输入的
// 星系 id 与服务器下发的原生 STL 段记录的键（按实际天体/空间站 id 键控）对不上，
// FTC 的缺失项提示要能说清这一成因（见 fuel-model.missingModelInputs）。
export function isSystemId(naturalId: string | undefined): boolean {
  if (naturalId === undefined) {
    return false;
  }
  const upper = naturalId.trim().toUpperCase();
  return upper !== '' && starsStore.getByNaturalId(upper) !== undefined;
}

export function getStarPosition(systemId: string): PrunApi.Position | undefined {
  return starsStore.getByNaturalId(systemId)?.position;
}
export function distance3d(a: PrunApi.Position, b: PrunApi.Position) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// 星系 id → 空间站 id 反查（成因② 修复：SFC 把空间站目的地规范化成所属星系 id）。
// 服务器下发的原生 STL 段记录按**实际天体/空间站 id** 键控（真实导出键 ZV-307A|ANT），
// 而 SFC 的目的地框会把空间站目的地规范化成所属星系 id（ANT → ZV-307，见
// prun-ui/utils/select-address.ts 与 FLEET/ChainView.vue）→ 同星系键的第二分量（以及
// 跨星系离港键的第一分量）永远对不上：5930 条记录里天体侧命中星系 id 的 = 0 条。
// 反查把「被规范化的星系 id」还原成空间站 id 后查表，这条航线才可能算出来。
//
// 数据源两级（合并去重后判唯一）：
//   ① 内置 public/json/stations.json（orbit.getStationsInSystem 的反向索引）：离线、
//      确定性，已核实 6 个空间站分属 6 个星系、一一对应；
//   ② 游戏内运行时站点（stationsStore：defaultStations 6 个站 + DATA_DATA 下发/访问过的站）：
//      补内置快照的滞后（游戏新增站点时内置 JSON 不会更新）。两级合并后仍是「数据不全
//      就不反查」，不会因为运行时数据缺失而给出错值。
// 安全守卫（反查必须**可证唯一**）：恰好 1 个候选才反查；0 个（无数据）或 ≥2 个
// （同星系多站 —— 无法判断目的地到底是哪一个）→ station 为 undefined，使用方保持
// 原有「不写滑块 + 提示」路径。宁可不写也不猜。
export interface StationSystemLookup {
  // 查询用的星系 id（大写归一）。
  systemId: string;
  // 反查到的唯一空间站 id；不唯一/无候选时为 undefined（即拒绝反查）。
  station?: string;
  // 候选空间站（诊断：不唯一时列出，缺失项文案据此说明为何拒绝反查）。
  candidates: string[];
}

export function lookupStationInSystem(
  systemId: string | undefined,
): StationSystemLookup | undefined {
  const upper = systemId?.trim().toUpperCase();
  if (upper === undefined || upper === '') {
    return undefined;
  }
  const candidates = new Set<string>(getStationsInSystem(upper));
  for (const station of stationsStore.all.value ?? []) {
    const naturalId = getEntityNaturalIdFromAddress(station.address);
    const system = getSystemLineFromAddress(station.address)?.entity.naturalId;
    if (naturalId !== undefined && system?.toUpperCase() === upper) {
      candidates.add(naturalId.trim().toUpperCase());
    }
  }
  const list = [...candidates].sort();
  return {
    systemId: upper,
    station: list.length === 1 ? list[0] : undefined,
    candidates: list,
  };
}
