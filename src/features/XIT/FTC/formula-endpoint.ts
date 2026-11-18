// 公式模型的端点解析：把「玩家/SFC 给的 naturalId」变成带实体 id 的地址。
//
// SFC 的地址框会把**空间站目的地规范化成所属星系 id**（ANT → ZV-307），而公式模型必须拿到
// 具体天体/空间站。所以这里按顺序尝试：
//   1) 直接解析该 naturalId；
//   2) 解析不到具体实体时，按「星系 id → 唯一空间站」反查后再解析（含内置 stations.json）；
//   3) 仍不行 → 抛出可操作的错误（多站时列出候选，绝不猜）。
//
// 解析结果按 naturalId 缓存：SFC 联动与 FLEET 环线估算会对同一批起终点反复调用，
// 不缓存就会每段重新发一次 NOMENCLATURE 查询。
import {
  getEntityNaturalIdFromAddress,
  getSystemLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import {
  encodeAddress,
  resolveEntity,
} from '@src/infrastructure/prun-api/data/flight-test-collector';
import { lookupStationInSystem } from './route-model';

const addressCache = new Map<string, PrunApi.Address>();
const addressInflight = new Map<string, Promise<PrunApi.Address | undefined>>();

async function resolveCached(naturalId: string) {
  const key = naturalId.trim().toUpperCase();
  const cached = addressCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const inflight = addressInflight.get(key);
  if (inflight !== undefined) {
    return inflight;
  }
  const pending = resolveEntity(naturalId.trim())
    .then(address => {
      if (address !== undefined) {
        addressCache.set(key, address);
      }
      return address;
    })
    .finally(() => addressInflight.delete(key));
  addressInflight.set(key, pending);
  return pending;
}

export interface ResolvedFormulaEndpoint {
  naturalId: string;
  systemId: string;
  // 编码后的地址（`系统实体id|PLA|STA,天体实体id`），飞行请求直接使用。
  encoded: string;
}

function describe(address: PrunApi.Address | undefined) {
  if (address === undefined) {
    return undefined;
  }
  const naturalId = getEntityNaturalIdFromAddress(address);
  const systemId = getSystemLineFromAddress(address)?.entity.naturalId;
  const encoded = encodeAddress(address);
  return naturalId === undefined || systemId === undefined || encoded === undefined
    ? undefined
    : { naturalId, systemId, encoded };
}

// 解析一个端点；星系 id 会反查成该星系的唯一空间站。
export async function resolveFormulaEndpoint(input: string): Promise<ResolvedFormulaEndpoint> {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('请输入起点和终点');
  }
  const direct = describe(await resolveCached(trimmed));
  if (direct !== undefined) {
    return direct;
  }
  const lookup = lookupStationInSystem(trimmed);
  if (lookup?.station !== undefined) {
    const station = describe(await resolveCached(lookup.station));
    if (station !== undefined) {
      return station;
    }
  }
  const candidates = lookup?.candidates ?? [];
  throw new Error(
    candidates.length > 1
      ? `${trimmed.toUpperCase()} 是星系且有多个空间站（${candidates.join('、')}）：请填写具体空间站或行星`
      : `无法解析 ${trimmed.toUpperCase()}：请填写具体行星或空间站代号`,
  );
}
