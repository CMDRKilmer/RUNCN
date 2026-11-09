import { userData } from '@src/store/user-data';
import { stripDeletedActions } from '@src/features/XIT/ACT/utils';
import { createId } from '@src/store/create-id';
import { isChainPackageName, isChainTrigger, shipChainScriptScope } from './chain-identity';
import type { ChainSyncDoc } from '@src/infrastructure/org-api/chain-sync';

// 事件为扁平对象，按键排序归一化后序列化，避免键序差异导致同一触发器签名不同。
export function canonicalEvent(event: UserData.TriggerEventData) {
  return Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b)));
}

function triggerSignature(t: UserData.TriggerData) {
  return JSON.stringify([t.name, t.packageName, canonicalEvent(t.event), t.mode]);
}

// 深拷贝（reactive 代理 → 纯对象），供 JSON 传输与整包替换。
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// 内容签名（不含 updatedAt）：判断该条目推送内容是否真的变化。
// 运行服务的粗粒度 watch 会把「未实际改动」的船与配置也标脏，若一律以新
// 时间戳推送会把云端（他端）对同一条目的更新覆盖掉、架空 LWW 保护。
// 推送前比对签名：内容未变则跳过且不推进时间戳。
export function contentSignature(doc: ChainSyncDoc): string {
  const content = { ...doc };
  delete (content as Partial<ChainSyncDoc>).updatedAt;
  // 触发器 id 是设备本地标识（applyShipDoc 拉取导入时用 createId 重新生成），
  // 不计入签名，避免「拉取后内容相同却多推一次」的抖动。
  content.triggers = (content.triggers ?? []).map(t => {
    const copy = { ...t };
    delete (copy as { id?: string }).id;
    return copy;
  });
  return JSON.stringify(content);
}

export function normalizeDoc(payload: unknown): ChainSyncDoc | null {
  const p = payload as Partial<ChainSyncDoc> | null;
  if (
    !p ||
    p.version !== 1 ||
    typeof p.updatedAt !== 'number' ||
    !p.chainRuns ||
    !Array.isArray(p.actionPackages) ||
    !Array.isArray(p.triggers)
  ) {
    return null;
  }
  return p as ChainSyncDoc;
}

// 对比数据：本地（各活跃船） vs 远端（各船）。
export interface SyncComparison {
  localShips: Map<string, ChainSyncDoc>;
  remoteShips: Map<string, ChainSyncDoc>;
  // 云端各条目服务端行时间（updated_at，CAS 乐观锁基准）；无远端记录时缺省。
  remoteServerUpdatedAt: Map<string, number>;
}

// 单船快照的包/触发器范围由 chain-identity 统一判定。
export function collectShipDoc(
  shipId: string,
  updatedAt: number,
  resolveShipName: (shipId: string) => string | undefined,
  clearedFp?: string,
): ChainSyncDoc {
  const run = userData.chainRuns[shipId];
  const scope = shipChainScriptScope(shipId, resolveShipName(shipId));
  return {
    version: 1,
    updatedAt,
    fp: run?.fp,
    clearedFp: run === undefined ? clearedFp : undefined,
    chainRuns: run === undefined ? {} : { [shipId]: clone(run) },
    actionPackages: userData.actionPackages
      .filter(p => isChainPackageName(p.global.name) && scope.has(p.global.name))
      .map(clone),
    triggers: userData.triggers
      .filter(t => isChainTrigger(t) && scope.has(t.packageName))
      .map(clone),
  };
}

// ── 应用 ─────────────────────────────────────────────────────────────
// 应用远端船快照：只动该船数据（chainRuns 该船条目 + 该船环线包/触发器），
// 不影响其他船。远端无该船条目时删除本地该船记录（删除传播）。
// 删除范围以「覆盖 chainRuns 前的本地归属快照」判定（shipId 级）：船改名后
// 旧名包仍能命中，不会因远端/本地名字不一致而误删或留下孤儿。
export function applyShipDoc(
  shipId: string,
  doc: ChainSyncDoc,
  resolveShipName: (shipId: string) => string | undefined,
): void {
  // 覆盖 chainRuns 前，先快照本地当前属于该船的包/触发器名（改名无关）。
  const localNames = shipChainScriptScope(shipId, resolveShipName(shipId));

  if (doc.chainRuns[shipId] !== undefined) {
    userData.chainRuns[shipId] = clone(doc.chainRuns[shipId]);
  } else {
    delete userData.chainRuns[shipId];
  }

  // 删除本地该船包中不在远端的（以远端名单为准，与名字是否匹配当前船名无关）。
  const remotePkgs = new Set(doc.actionPackages.map(p => p.global.name));
  for (let i = userData.actionPackages.length - 1; i >= 0; i--) {
    const pkg = userData.actionPackages[i]!;
    if (localNames.has(pkg.global.name) && !remotePkgs.has(pkg.global.name)) {
      userData.actionPackages.splice(i, 1);
    }
  }
  for (const pkg of doc.actionPackages) {
    stripDeletedActions(pkg);
    const index = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
    if (index >= 0) {
      userData.actionPackages[index] = pkg;
    } else {
      userData.actionPackages.push(pkg);
    }
  }
  const localIds = new Map(userData.triggers.map(x => [triggerSignature(x), x.id]));
  for (let i = userData.triggers.length - 1; i >= 0; i--) {
    const trigger = userData.triggers[i];
    if (isChainTrigger(trigger) && localNames.has(trigger.packageName)) {
      userData.triggers.splice(i, 1);
    }
  }
  for (const trigger of doc.triggers) {
    userData.triggers.push({
      ...trigger,
      id: localIds.get(triggerSignature(trigger)) ?? createId(),
    });
  }
}
