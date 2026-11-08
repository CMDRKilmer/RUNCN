// src/infrastructure/org-api/chain-sync.ts
// 环线多端同步客户端：经 org-api 服务器在跨浏览器/设备间同步环线快照。
// 命名空间 = 公司代码（后端从 JWT 取 company_code）；每条记录 = 一艘船的
// 环线快照，船之间互不覆盖；全局面板配置只保存在本地。
// 推送带 baseUpdatedAt 乐观锁：库内该船已有更新时返回 409，调用方重新合并。
import { HttpError, request } from './client';

// 历史 __config__ 快照形状，仅保留读取类型兼容；当前客户端不收发此条目。
export interface ChainSyncConfig {
  chainGroup?: string;
  chainShipIds?: string[];
  chainBaseIds?: string[];
  chainAutoLaunch?: boolean;
  chainAutoTrigger?: boolean;
  chainAutoRecover?: boolean;
}

// 单船同步快照；历史 __config__ 条目由调用方忽略。
export interface ChainSyncDoc {
  version: 1;
  // 数据最后修改时间（毫秒）；LWW 冲突解决基准。
  updatedAt: number;
  // 仅 '__config__' 条目携带。
  config?: ChainSyncConfig;
  // 环线代际指纹（有运行记录时）：该船当前 run 的 fp，见 ChainRun.fp。
  fp?: string;
  // 代际清除标记（空快照删除传播时）：被删除 run 的 fp——轻量 tombstone，
  // 对端据此识别「我持有的同一代已被清除」，防止旧数据复活。
  clearedFp?: string;
  // 运行状态：按 shipId 的进度快照（船条目只含本船）。
  chainRuns: Record<string, UserData.ChainRun>;
  // 环线相关操作包（船条目只含本船）。
  actionPackages: UserData.ActionPackageData[];
  // 环线相关触发器（船条目只含本船）。
  triggers: UserData.TriggerData[];
}

// 远端快照（GET / PUT 409 latest 同形）。
export interface ChainSyncRemote {
  shipId: string;
  payload: unknown;
  payloadVersion: number;
  updatedAt: number;
  updatedBy: string;
}

// GET /chain-sync → 当前公司全部船（含 '__config__'）的快照数组。
export async function fetchChainSyncs(): Promise<ChainSyncRemote[]> {
  const res = await request<{ items: ChainSyncRemote[] }>('/chain-sync');
  return res.items ?? [];
}

// GET /chain-sync/single?ship={id} → 单船快照；无数据返回 null。
export async function fetchChainSync(shipId: string): Promise<ChainSyncRemote | null> {
  return (
    (await request<ChainSyncRemote | null>(
      `/chain-sync/single?ship=${encodeURIComponent(shipId)}`,
    )) ?? null
  );
}

// PUT /chain-sync：按船乐观锁推送。
// 成功 → { ok: true, updatedAt }（服务器时间）；冲突 → { ok: false, latest }。
export async function pushChainSync(
  shipId: string,
  payload: ChainSyncDoc,
  baseUpdatedAt: number,
): Promise<{ ok: true; updatedAt: number } | { ok: false; latest: ChainSyncRemote | null }> {
  try {
    const res = await request<{ updatedAt: number }>('/chain-sync', {
      method: 'PUT',
      body: { shipId, payload, payloadVersion: payload.version, baseUpdatedAt },
    });
    return { ok: true, updatedAt: res.updatedAt };
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) {
      // 冲突：该船库内已有更新，重新拉取最新快照供调用方合并。
      return { ok: false, latest: await fetchChainSync(shipId) };
    }
    throw e;
  }
}
