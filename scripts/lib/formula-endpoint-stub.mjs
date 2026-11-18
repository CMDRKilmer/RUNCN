// 端点解析（src/features/XIT/FTC/formula-endpoint.ts）在 Node 下的测试替身。
//
// 替换：NOMENCLATURE 地址解析（resolveEntity）、地址行读取两个纯函数、星系→空间站反查。
// 解析顺序 / 反查回退 / 报错文案保持真实实现。
//
// 局限：`encodeAddress` 是本地等价实现（生产实现只做地址行拼装，不含被测逻辑）。

export const state = {
  addresses: new Map(),
  stations: new Map(),
  resolveCalls: [],
};

export function stubReset() {
  state.addresses.clear();
  state.stations.clear();
  state.resolveCalls.length = 0;
}

const line = (type, naturalId) => ({ type, entity: { naturalId, id: `id-${naturalId}` } });
export const address = (systemId, kind, bodyId) => ({
  lines: [line('SYSTEM', systemId), line(kind, bodyId)],
});
export const starOnlyAddress = systemId => ({ lines: [line('SYSTEM', systemId)] });

// naturalId → 地址（大小写不敏感，与游戏的 NOMENCLATURE 查询同口径）。
export function stubSetAddress(naturalId, value) {
  state.addresses.set(naturalId.toUpperCase(), value);
}

// 星系 id → 候选空间站（模拟 lookupStationInSystem 的结果）。
export function stubSetStations(systemId, candidates) {
  state.stations.set(systemId.toUpperCase(), [...candidates].sort());
}

// '@src/infrastructure/prun-api/data/flight-test-collector'
export async function resolveEntity(naturalId) {
  const key = naturalId.trim().toUpperCase();
  state.resolveCalls.push(key);
  return state.addresses.get(key);
}

export function encodeAddress(value) {
  const system = value?.lines?.find(x => x.type === 'SYSTEM')?.entity;
  const body = value?.lines?.find(x => x.type === 'PLANET' || x.type === 'STATION')?.entity;
  if (!system?.id || !body?.id) {
    return undefined;
  }
  const kind = value.lines.some(x => x.type === 'STATION') ? 'STA' : 'PLA';
  return `${system.id}|${kind},${body.id}`;
}

// '@src/infrastructure/prun-api/data/addresses'
export const getEntityNaturalIdFromAddress = value =>
  value?.lines?.find(x => x.type === 'PLANET' || x.type === 'STATION')?.entity?.naturalId;

export const getSystemLineFromAddress = value => value?.lines?.find(x => x.type === 'SYSTEM');

// './route-model'
export function lookupStationInSystem(systemId) {
  const upper = systemId?.trim().toUpperCase();
  if (upper === undefined || upper === '') {
    return undefined;
  }
  const candidates = state.stations.get(upper) ?? [];
  return {
    systemId: upper,
    station: candidates.length === 1 ? candidates[0] : undefined,
    candidates,
  };
}
