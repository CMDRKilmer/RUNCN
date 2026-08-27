// src/features/XIT/FLEET/chain-sync.ts
// 环线多端同步：跨浏览器/设备经 org-api 服务器同步环线快照。
// - 按船同步：每艘船（chainRuns + 该船环线 ACT 包/触发器）独立一条快照，
//   互不覆盖；'__config__' 存环线面板全局配置。
// - 无自动轮询：仅在本地环线运行状态改变（ChainView watch 触发 markDirtyShip/
//   markDirtyConfig）时防抖推送；覆盖仅由「云端同步」对话框手动选择。
import { userData } from '@src/store/user-data';
import { stripDeletedActions } from '@src/features/XIT/ACT/utils';
import { createId } from '@src/store/create-id';
import { nextTick } from 'vue';
import { HttpError } from '@src/infrastructure/org-api/client';
import {
  fetchChainSync,
  fetchChainSyncs,
  pushChainSync,
  type ChainSyncConfig,
  type ChainSyncDoc,
} from '@src/infrastructure/org-api/chain-sync';

// 特殊条目：环线面板全局配置。
export const CONFIG_KEY = '__config__';

// ── 环线数据识别（与 ChainView 同一套命名约定）────────────────
// 环线相关 = 本面板生成的到港触发器与其操作包（主包/站点包/归航包）。
// 命名约定与 buildChainActionPackages / sanitizeActName 一致：
//   主包       `0 Chain ${船名}`（旧版 `Chain ${船名}`）
//   站点包     `${序号} ${站点} Loop ${船名}`（旧版 `${站点} Loop/环线 ${船名}`）
//   归航包     `${序号} Chain Return ${船名}`（旧版 `Chain Return/环线归航 ${船名}`）
export function isChainPackageName(name: string): boolean {
  return (
    /(?:^|\s)\d+\s+Chain(?: Return)?\s/.test(name) ||
    name.startsWith('Chain ') ||
    name.startsWith('环线归航 ') ||
    name.includes(' Loop ') ||
    name.includes(' 环线 ')
  );
}

export function isChainTrigger(t: UserData.TriggerData): boolean {
  return t.event.type === 'FLIGHT_ENDED' && isChainPackageName(t.packageName);
}

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

// 时间戳显示（同步提示用）。
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

// 远端 payload 形状校验（透传数据，前端自校验）。
function normalizeDoc(payload: unknown): ChainSyncDoc | null {
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

// 对比数据：本地（config + 各活跃船） vs 远端（config + 各船）。
export interface SyncComparison {
  localConfig: ChainSyncDoc;
  localShips: Map<string, ChainSyncDoc>;
  remoteConfig: ChainSyncDoc | null;
  remoteShips: Map<string, ChainSyncDoc>;
}

// ── 收集 ─────────────────────────────────────────────────────────────
// 该船快照：chainRuns 只含本船（无运行记录时为空），操作包/触发器只含本船。
// 本地无该船记录时仍返回快照（chainRuns 空）——「用本地覆盖云端」可据此清空云端。
function collectShipDoc(
  shipId: string,
  updatedAt: number,
  resolveShipName: (shipId: string) => string | undefined,
): ChainSyncDoc {
  const run = userData.chainRuns[shipId];
  const shipName = resolveShipName(shipId);
  const matches = (name: string) =>
    shipName !== undefined && (name.endsWith(` ${shipName}`) || name === `环线派遣 ${shipName}`);
  return {
    version: 1,
    updatedAt,
    chainRuns: run === undefined ? {} : { [shipId]: clone(run) },
    actionPackages: userData.actionPackages
      .filter(p => isChainPackageName(p.global.name) && matches(p.global.name))
      .map(clone),
    triggers: userData.triggers.filter(t => isChainTrigger(t) && matches(t.packageName)).map(clone),
  };
}

// 全局配置快照（'__config__'）。
function collectConfigDoc(config: ChainSyncConfig, updatedAt: number): ChainSyncDoc {
  return {
    version: 1,
    updatedAt,
    config,
    chainRuns: {},
    actionPackages: [],
    triggers: [],
  };
}

// ── 应用 ─────────────────────────────────────────────────────────────
// 应用远端船快照：只动该船数据（chainRuns 该船条目 + 该船环线包/触发器），
// 不影响其他船。远端无该船条目时删除本地该船记录（删除传播）。
function applyShipDoc(
  shipId: string,
  doc: ChainSyncDoc,
  resolveShipName: (shipId: string) => string | undefined,
): void {
  if (doc.chainRuns[shipId] !== undefined) {
    userData.chainRuns[shipId] = clone(doc.chainRuns[shipId]);
  } else {
    delete userData.chainRuns[shipId];
  }
  const shipName = resolveShipName(shipId);
  const matches = (name: string) =>
    shipName !== undefined && (name.endsWith(` ${shipName}`) || name === `环线派遣 ${shipName}`);
  const remotePkgs = new Set(doc.actionPackages.map(p => p.global.name));
  for (let i = userData.actionPackages.length - 1; i >= 0; i--) {
    const pkg = userData.actionPackages[i]!;
    if (
      isChainPackageName(pkg.global.name) &&
      matches(pkg.global.name) &&
      !remotePkgs.has(pkg.global.name)
    ) {
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
  const remoteTriggers = new Set(doc.triggers.map(triggerSignature));
  for (let i = userData.triggers.length - 1; i >= 0; i--) {
    const t = userData.triggers[i]!;
    if (isChainTrigger(t) && matches(t.packageName) && !remoteTriggers.has(triggerSignature(t))) {
      userData.triggers.splice(i, 1);
    }
  }
  const localSignatures = new Set(userData.triggers.map(triggerSignature));
  for (const trigger of doc.triggers) {
    if (localSignatures.has(triggerSignature(trigger))) {
      continue;
    }
    userData.triggers.push({ ...trigger, id: createId() });
    localSignatures.add(triggerSignature(trigger));
  }
}

// ── 同步状态 ─────────────────────────────────────────────────────────
export interface ChainSyncState {
  syncing: boolean;
  lastSyncAt: number | null;
  dirty: boolean;
  conflict: boolean;
  error: string | null;
}

export interface ChainSyncControllerOptions {
  // 读取当前环线配置（tileState 各字段）。
  getConfig: () => ChainSyncConfig;
  // 应用远端配置到本地（写 tileState）。ChainGroup 变化会触发其 watch 清空
  // chainBaseIds，故实现需用 nextTick 保证先设 group、watch flush 后再设其余。
  applyConfig: (config: ChainSyncConfig) => void;
  // shipId → 该船名（净化后的环线包名后缀）。无法解析时返回 undefined。
  resolveShipName: (shipId: string) => string | undefined;
  // 状态回调（可选）：同步状态变化时通知 UI。
  onState?: (state: ChainSyncState) => void;
  // 提示回调（可选）：合并/冲突等事件。
  onNotice?: (message: string) => void;
}

const PUSH_DEBOUNCE_MS = 5000;

export function createChainSyncController(opts: ChainSyncControllerOptions) {
  const state: ChainSyncState = reactive({
    syncing: false,
    lastSyncAt: null,
    dirty: false,
    conflict: false,
    error: null,
  });

  // 每个同步条目（船 / '__config__'）独立基准。
  interface SyncEntry {
    remoteUpdatedAt: number; // LWW 比较基准（payload 内时间戳）
    remoteBaseUpdatedAt: number; // 乐观锁基准（服务器 updated_at）
    lastLocalChangeAt: number; // 本地最后修改时间
    dirty: boolean;
  }
  const entries = new Map<string, SyncEntry>();

  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  // 应用远端后的下一次数据变化（watch 触发）由远端本身引起，抑制其 markDirty，
  // 避免「应用远端 → 重推 → 远端更新 → 再应用」的无限同步循环。
  let suppressDirty = false;

  function entry(key: string): SyncEntry {
    let e = entries.get(key);
    if (!e) {
      e = { remoteUpdatedAt: 0, remoteBaseUpdatedAt: 0, lastLocalChangeAt: 0, dirty: false };
      entries.set(key, e);
    }
    return e;
  }

  function setState(patch: Partial<ChainSyncState>) {
    Object.assign(state, patch);
    opts.onState?.(state);
  }

  function entryLabel(key: string): string {
    if (key === CONFIG_KEY) {
      return '';
    }
    const name = opts.resolveShipName(key);
    return name ? `${name} ` : '该船 ';
  }

  function markDirtyShip(shipId: string) {
    if (suppressDirty) {
      return;
    }
    const e = entry(shipId);
    e.lastLocalChangeAt = Date.now();
    e.dirty = true;
    setState({ dirty: true, conflict: false, error: null });
    schedulePush();
  }

  function markDirtyConfig() {
    markDirtyShip(CONFIG_KEY);
  }

  function schedulePush() {
    if (!started) {
      return;
    }
    if (pushTimer) {
      clearTimeout(pushTimer);
    }
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void pushNow();
    }, PUSH_DEBOUNCE_MS);
  }

  function errorMessage(e: unknown) {
    if (e instanceof HttpError && e.status === 401) {
      return null; // 未登录：静默（ORG 的 AuthOverlay 会接管）。
    }
    if (e instanceof TypeError) {
      // 网络不可达（org-api 未部署/未配置）：静默降级，本地照常。
      return null;
    }
    return e instanceof Error ? e.message : String(e);
  }

  // 推送所有 dirty 条目（每船只推自己的数据）。
  // force=true：跳过 LWW 拒绝（用户已在对话框确认「本地覆盖云端」）；
  // targetKey：只推送指定条目（船 id 或 '__config__'）。
  // 推送指定条目（force=true 跳过 LWW 拒绝；targetKey 限定单条，entry 自动创建）。
  async function pushNow(force = false, targetKey?: string): Promise<void> {
    if (state.syncing || !started) {
      return;
    }
    setState({ syncing: true });
    try {
      const keys = targetKey !== undefined ? [targetKey] : [...entries.keys()];
      for (const key of keys) {
        const e = entry(key);
        if (!e.dirty && !force) {
          continue;
        }
        // 首推前先拉该船基准（乐观锁用服务器 updated_at，LWW 用 payload 时间戳）。
        if (e.remoteBaseUpdatedAt === 0) {
          const remote = await fetchChainSync(key);
          if (remote) {
            e.remoteBaseUpdatedAt = remote.updatedAt;
            e.remoteUpdatedAt = normalizeDoc(remote.payload)?.updatedAt ?? 0;
          }
        }
        const localUpdatedAt = e.lastLocalChangeAt > 0 ? e.lastLocalChangeAt : Date.now();
        // LWW：云端较新时拒绝上传，避免静默覆盖另一端（force 跳过）。
        if (!force && e.remoteUpdatedAt > localUpdatedAt) {
          setState({ conflict: true });
          opts.onNotice?.(
            `${entryLabel(key)}云端较新（${formatTime(e.remoteUpdatedAt)}），请先下拉。`,
          );
          continue; // 保持 dirty
        }
        const doc =
          key === CONFIG_KEY
            ? collectConfigDoc(opts.getConfig(), localUpdatedAt)
            : collectShipDoc(key, localUpdatedAt, opts.resolveShipName);
        let res = await pushChainSync(key, doc, e.remoteBaseUpdatedAt);
        if (!res.ok && force && res.latest) {
          // 用户已确认覆盖云端：以最新 base 重试一次。
          e.remoteBaseUpdatedAt = res.latest.updatedAt;
          e.remoteUpdatedAt = normalizeDoc(res.latest.payload)?.updatedAt ?? 0;
          res = await pushChainSync(key, doc, e.remoteBaseUpdatedAt);
        }
        if (res.ok) {
          e.remoteBaseUpdatedAt = res.updatedAt;
          e.remoteUpdatedAt = doc.updatedAt;
          e.dirty = false;
          setState({ lastSyncAt: res.updatedAt, error: null });
          if (force) {
            opts.onNotice?.(`${entryLabel(key) || '配置'}已用本地覆盖云端。`);
          }
        } else {
          // 409 并发冲突：该船云端已被更新。拒绝覆盖，提示先下拉。
          const latest = res.latest;
          if (latest) {
            e.remoteBaseUpdatedAt = latest.updatedAt;
            e.remoteUpdatedAt = normalizeDoc(latest.payload)?.updatedAt ?? 0;
            setState({ conflict: true });
            opts.onNotice?.(`${entryLabel(key)}上传冲突：云端较新，请先下拉。`);
          }
        }
      }
      if (![...entries.values()].some(x => x.dirty)) {
        setState({ dirty: false });
      }
    } catch (e) {
      const msg = errorMessage(e);
      if (msg) {
        setState({ error: msg });
      }
    } finally {
      setState({ syncing: false });
    }
  }

  // 应用远端（抑制由此引发的 markDirty）。
  function suppressFor(fn: () => void) {
    suppressDirty = true;
    fn();
    void nextTick().then(() => {
      suppressDirty = false;
    });
  }

  // 用户确认「用云端覆盖本地」（指定船或 '__config__'）。
  function confirmPull(shipId: string, doc: ChainSyncDoc): void {
    suppressFor(() => {
      if (shipId === CONFIG_KEY) {
        if (doc.config) {
          opts.applyConfig(doc.config);
        }
      } else {
        applyShipDoc(shipId, doc, opts.resolveShipName);
      }
    });
    const e = entry(shipId);
    e.lastLocalChangeAt = doc.updatedAt;
    e.dirty = false;
    setState({ conflict: false, error: null });
    opts.onNotice?.(`已用云端覆盖${entryLabel(shipId) || '配置'}。`);
  }

  // 对比数据：本地（config + 各活跃船） vs 远端（config + 各船）。
  async function prepareComparison(): Promise<SyncComparison | null> {
    if (state.syncing) {
      return null;
    }
    setState({ syncing: true });
    try {
      const remotes = await fetchChainSyncs();
      const localShips = new Map<string, ChainSyncDoc>();
      for (const shipId of Object.keys(userData.chainRuns)) {
        const doc = collectShipDoc(
          shipId,
          entry(shipId).lastLocalChangeAt > 0 ? entry(shipId).lastLocalChangeAt : Date.now(),
          opts.resolveShipName,
        );
        localShips.set(shipId, doc);
      }
      const localConfig = collectConfigDoc(
        opts.getConfig(),
        entry(CONFIG_KEY).lastLocalChangeAt > 0 ? entry(CONFIG_KEY).lastLocalChangeAt : Date.now(),
      );
      let remoteConfig: ChainSyncDoc | null = null;
      const remoteShips = new Map<string, ChainSyncDoc>();
      for (const r of remotes) {
        const doc = normalizeDoc(r.payload);
        if (!doc) {
          continue;
        }
        if (r.shipId === CONFIG_KEY) {
          remoteConfig = doc;
        } else {
          remoteShips.set(r.shipId, doc);
        }
      }
      return { localConfig, localShips, remoteConfig, remoteShips };
    } catch (e) {
      const msg = errorMessage(e);
      if (msg) {
        setState({ error: msg });
      }
      return null;
    } finally {
      setState({ syncing: false });
    }
  }

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    // 无自动拉取/轮询：仅在本地环线状态改变时推送。
  }

  function stop(): void {
    started = false;
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
  }

  return {
    state,
    start,
    stop,
    markDirtyShip,
    markDirtyConfig,
    pushNow,
    prepareComparison,
    confirmPull,
  };
}
