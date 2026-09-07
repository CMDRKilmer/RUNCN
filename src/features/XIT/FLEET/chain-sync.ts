// src/features/XIT/FLEET/chain-sync.ts
// 环线多端同步：跨浏览器/设备经 org-api 服务器同步环线快照。
// - 按船同步：每艘船（chainRuns + 该船环线 ACT 包/触发器）独立一条快照，
//   互不覆盖；'__config__' 存环线面板全局配置。
// - 无自动轮询：仅在本地环线运行状态改变（ChainView watch 触发 markDirtyShip/
//   markDirtyConfig）时防抖推送；覆盖仅由「云端同步」对话框手动选择。
// - 冲突闸：条目一旦发生实质冲突（LWW 拒绝 / 409 且内容不一致）即标记
//   awaitingMerge，自动推送不再触碰该条目，直到用户在「云端同步」对话框手动
//   下拉（pull）或强制上传（force）——防止 409 刷新基准后以本地时钟静默覆盖
//   他端更新（跨设备时钟偏差下 LWW 会误判本地较新）。标记跨会话持久化。
// - 代际指纹：execute() 铸入 10 位 hex fp 并嵌入各 ACT 包/触发器名末尾
//   （` <fp>`）。本船 run 记录与云端 doc 均带 fp（空快照删除传播带 clearedFp）；
//   归属枚举优先按 fp（改名无关）；409 时按代际规则自动收敛（他端清了同一代 →
//   本地自动删；本地清了同一代而云端仍是同代 run → 自动重推空快照），防旧数据复活。
// - 代际 tombstone 本地跟踪：entry.clearedFp = 本端已知「云端已清除」的代际
//   （自己清理 / 采纳远端清除 / 409 刷新时记录，跨会话持久化）。推送前若本地
//   run 的代际 == clearedFp（残留脚本被导入/重建），直接移除本地而非推回云端——
//   堵住「采纳清除后基准已刷新、同代残留经 CAS 直接放行复活」的洞。
import { userData } from '@src/store/user-data';
import { stripDeletedActions } from '@src/features/XIT/ACT/utils';
import { chainFpSuffix } from '@src/features/XIT/FLEET/chain-planner';
import { createId } from '@src/store/create-id';
import { nextTick } from 'vue';
import { HttpError } from '@src/infrastructure/org-api/client';
import { loadSession } from '@src/infrastructure/org-api/session';
import {
  fetchChainSync,
  fetchChainSyncs,
  pushChainSync,
  type ChainSyncConfig,
  type ChainSyncDoc,
} from '@src/infrastructure/org-api/chain-sync';

// 特殊条目：环线面板全局配置。
export const CONFIG_KEY = '__config__';

// ── 同步基准跨会话持久化 ────────────────────────────────────────
// SyncEntry（CAS base / LWW 时间 / 推送签名）只存在内存：页面重载后归零会让
// 首次推送以「当前云端时间」当 base（CAS 放行）且签名跳过失效，陈旧本地可能
// 静默覆盖他端离线期间的更新。把每条目基准持久化到 localStorage（按公司隔离），
// 重载后：内容未变的条目仍跳过；有本地改动的条目带旧 base 推送，他端更新过则
// 409 → 提示下拉，CAS/LWW 语义跨会话恢复。
interface BaselineRecord {
  base: number; // 服务端行时间（updated_at，CAS 乐观锁基准）
  ts: number; // 云端 payload 时间戳（LWW 比较基准）
  sig: string | null; // 上次成功推送/拉取内容的签名
  merge?: boolean; // 冲突待人工合并（awaitingMerge 的跨会话持久化）
  cleared?: string; // 本地已知被云端清除的代际 fp（推送侧防复活守卫，跨会话持久化）
}
type BaselineMap = Record<string, BaselineRecord>;

function baselineStorageKey(): string {
  let company = 'default';
  try {
    company = loadSession()?.user?.companyCode || 'default';
  } catch {
    // 读取会话失败：退回默认桶。
  }
  return `rprun-chain-sync-baselines:${company}`;
}

function loadBaselines(): BaselineMap {
  try {
    const raw = localStorage.getItem(baselineStorageKey());
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as BaselineMap;
      }
    }
  } catch {
    // 存储损坏：回退空。
  }
  return {};
}

function saveBaselines(map: BaselineMap): void {
  try {
    localStorage.setItem(baselineStorageKey(), JSON.stringify(map));
  } catch {
    // 忽略写入失败（隐私模式/配额）。
  }
}

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

// 内容签名（不含 updatedAt）：判断该条目推送内容是否真的变化。
// ChainView 的粗粒度 watch 会把「未实际改动」的船与配置也标脏，若一律以新
// 时间戳推送会把云端（他端）对同一条目的更新覆盖掉、架空 LWW 保护。
// 推送前比对签名：内容未变则跳过且不推进时间戳。
function contentSignature(doc: ChainSyncDoc): string {
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
  // 云端各条目服务端行时间（updated_at，CAS 乐观锁基准）；无远端记录时缺省。
  remoteServerUpdatedAt: Map<string, number>;
}

// ── 船的环线脚本归属（shipId 级关联）────────────────────────────
// 环线包/触发器名里只编码了「船名」（命名时没有 shipId）。若按当前船名做后缀
// 匹配：船改名后本端会找不到旧名包（推送变空/误删云端），且船名互为后缀时
// （如「Cargo」与「Big Cargo」）会互相误收/误删。
// 归属判定改为以 shipId 为锚：chainRuns[shipId] 里固化的包名（main/final/
// stops，执行时写入、与后续改名无关）是权威来源；当前船名匹配只作兜底，
// 且当包名已被其它船的运行固化时让给那艘船，避免后缀误收。
function runPackageNames(run: UserData.ChainRun | undefined): Set<string> {
  const names = new Set<string>();
  if (!run) {
    return names;
  }
  if (run.mainPkgName) {
    names.add(run.mainPkgName);
  }
  if (run.finalPkgName) {
    names.add(run.finalPkgName);
  }
  for (const stop of run.stops) {
    if (stop.pkgName) {
      names.add(stop.pkgName);
    }
  }
  return names;
}

function nameMatchesShip(name: string, shipName: string): boolean {
  return name.endsWith(` ${shipName}`) || name === `环线派遣 ${shipName}`;
}

// 某船当前的环线脚本名集合（shipId 级关联，collect/apply/清理共用）：
// 权威（新版本）= 本船 run 的代际指纹（chainRuns[shipId].fp，创建时铸入、改名无关）——
//   凡以 ` <fp>` 结尾的环线包/触发器都属于本船，无需再按船名后缀/让位判断；
// 兜底（legacy，无 fp）= chainRuns[shipId] 固化包名（main/final/stops）∪
//   当前船名后缀匹配的孤儿/历史残留（已被其它船运行固化的让出）。
export function shipChainScriptScope(shipId: string, shipName: string | undefined): Set<string> {
  const names = runPackageNames(userData.chainRuns[shipId]);
  const fp = userData.chainRuns[shipId]?.fp;
  if (fp !== undefined) {
    // fp 权威分支：直接按代际指纹枚举，船名/改名完全无关。
    const suffix = chainFpSuffix(fp);
    for (const pkg of userData.actionPackages) {
      if (isChainPackageName(pkg.global.name) && pkg.global.name.endsWith(suffix)) {
        names.add(pkg.global.name);
      }
    }
    for (const trigger of userData.triggers) {
      if (isChainTrigger(trigger) && trigger.packageName.endsWith(suffix)) {
        names.add(trigger.packageName);
      }
    }
    return names;
  }
  if (shipName === undefined) {
    return names;
  }
  const claimedByOther = (name: string) =>
    Object.entries(userData.chainRuns).some(
      ([otherId, run]) => otherId !== shipId && runPackageNames(run).has(name),
    );
  const collectMatch = (name: string) => {
    if (nameMatchesShip(name, shipName) && !claimedByOther(name)) {
      names.add(name);
    }
  };
  for (const pkg of userData.actionPackages) {
    if (isChainPackageName(pkg.global.name)) {
      collectMatch(pkg.global.name);
    }
  }
  for (const trigger of userData.triggers) {
    if (isChainTrigger(trigger)) {
      collectMatch(trigger.packageName);
    }
  }
  return names;
}

// ── 收集 ─────────────────────────────────────────────────────────────
// 该船快照：chainRuns 只含本船（无运行记录时为空），操作包/触发器只含本船。
// 本地无该船记录时仍返回快照（chainRuns 空）——「用本地覆盖云端」可据此清空云端。
// clearedFp：无运行记录时由调用方传入本船「本地已知被云端清除」的代际指纹
// （来自 entry.clearedFp），作为空快照删除传播的轻量 tombstone；缺省省略
// （旧版空快照语义）。
function collectShipDoc(
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
// 删除范围以「覆盖 chainRuns 前的本地归属快照」判定（shipId 级）：船改名后
// 旧名包仍能命中，不会因远端/本地名字不一致而误删或留下孤儿。
function applyShipDoc(
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
  const remoteTriggers = new Set(doc.triggers.map(triggerSignature));
  for (let i = userData.triggers.length - 1; i >= 0; i--) {
    const trigger = userData.triggers[i]!;
    if (
      isChainTrigger(trigger) &&
      localNames.has(trigger.packageName) &&
      !remoteTriggers.has(triggerSignature(trigger))
    ) {
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
    // 冲突待人工合并：409/LWW 拒绝后置位；未在对话框手动处理前，自动推送
    // 跳过该条目（防止 409 刷新基准后静默覆盖他端更新）。
    awaitingMerge: boolean;
    // 本地已知被云端清除的代际 fp（自己清理/采纳远端清除/409 刷新时记录）。
    // 推送前拦截同代残留（见 performPush 守卫），防「采纳清除后基准已刷新、
    // 同代残留经 CAS 直接放行」的复活洞。
    clearedFp: string | undefined;
    // 上次成功推送/拉取内容的签名（不含 updatedAt）：内容未变时跳过推送。
    pushedSignature: string | null;
  }
  const entries = new Map<string, SyncEntry>();
  // 跨会话恢复的同步基准（重载后 entry 从零开始，用上次持久化的值初始化）。
  const persisted = loadBaselines();

  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  // 应用远端后的下一次数据变化（watch 触发）由远端本身引起，抑制其 markDirty，
  // 避免「应用远端 → 重推 → 远端更新 → 再应用」的无限同步循环。
  let suppressDirty = false;

  function entry(key: string): SyncEntry {
    let e = entries.get(key);
    if (!e) {
      const saved = persisted[key];
      e = {
        remoteUpdatedAt: saved?.ts ?? 0,
        remoteBaseUpdatedAt: saved?.base ?? 0,
        lastLocalChangeAt: 0,
        dirty: false,
        // 冲突闸跨会话恢复：重载后该条目仍需人工处理才能再次自动推送。
        awaitingMerge: saved?.merge === true,
        // 已清除代际恢复：重载后仍拦截同代残留推回（防复活守卫跨会话生效）。
        clearedFp: saved?.cleared,
        pushedSignature: saved?.sig ?? null,
      };
      entries.set(key, e);
    }
    return e;
  }

  // 把「有意义」的条目基准写回 localStorage（成功推送/拉取/冲突刷新后）。
  // 先读现有再合并覆盖：多标签页/多实例各持自己的 entries，避免互相清除。
  function persistBaselines(): void {
    const stored = loadBaselines();
    for (const [key, e] of entries) {
      if (
        e.remoteBaseUpdatedAt > 0 ||
        e.remoteUpdatedAt > 0 ||
        e.pushedSignature !== null ||
        e.clearedFp !== undefined
      ) {
        stored[key] = {
          base: e.remoteBaseUpdatedAt,
          ts: e.remoteUpdatedAt,
          sig: e.pushedSignature,
          // 冲突闸与已清除代际一并持久化（undefined 时 JSON 序列化自动省略）。
          merge: e.awaitingMerge || undefined,
          cleared: e.clearedFp || undefined,
        };
      }
    }
    saveBaselines(stored);
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

  // 是否存在「冲突未解决、待人工合并」的条目（awaitingMerge 且未同步）。
  // 全局 conflict 标志的事实来源：新变化/批次结束都应据此重算，避免某船
  // 的未解决冲突被其它船的新变化或同批成功推送掩盖。
  function hasPendingMerge(): boolean {
    return [...entries.values()].some(x => x.awaitingMerge && x.dirty);
  }

  function markDirtyShip(shipId: string) {
    if (suppressDirty) {
      return;
    }
    const e = entry(shipId);
    e.lastLocalChangeAt = Date.now();
    e.dirty = true;
    // 仅当没有任何「冲突待处理」条目时才清 conflict：其它船/配置上的未解决
    // 冲突不应被本船的新变化掩盖（保持状态条「有冲突」提示）。
    setState({ dirty: true, conflict: hasPendingMerge(), error: null });
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

  // 本地出现「已被云端清除的代际」的 run（残留脚本经导入/手动重建）：直接按
  // 清除收敛——移除本地 run 与脚本并清脏、对齐内容签名，不推回云端。与 409
  // 的 adoptRemote 不同：这里不刷新 CAS 基准（云端本就处于该代已清状态，基准
  // 已在采纳清除/推送清除时对齐），只做本地清除。
  function discardClearedGen(shipId: string, clearedFp: string): void {
    const emptyDoc: ChainSyncDoc = {
      version: 1,
      updatedAt: Date.now(),
      clearedFp,
      chainRuns: {},
      actionPackages: [],
      triggers: [],
    };
    suppressFor(() => {
      applyShipDoc(shipId, emptyDoc, opts.resolveShipName);
    });
    const e = entry(shipId);
    e.lastLocalChangeAt = Date.now();
    e.dirty = false;
    e.awaitingMerge = false;
    // 与云端已清状态的内容签名对齐：同代残留再出现也只会再次走推送前守卫。
    e.pushedSignature = contentSignature(emptyDoc);
    setState({ conflict: hasPendingMerge(), error: null });
    persistBaselines();
  }

  // 记录本端「清理计划」删除了某代际（run 删除前传入 fp）。只记录不调度：
  // 调用方在删除 run 后照常 markDirtyShip 触发空快照（带 clearedFp）推送。
  // 立即持久化：清理可能发生在离线/推送失败前——重载后靠 start() 补推。
  function markShipCleared(shipId: string, fp: string): void {
    entry(shipId).clearedFp = fp;
    persistBaselines();
  }

  // 执行推送批次：推送所有 dirty 条目（每船只推自己的数据）。
  // force=true：跳过 LWW 拒绝与内容签名跳过（用户已在对话框确认「本地覆盖云端」）；
  // targetKey：只推送指定条目（船 id 或 '__config__'）。
  async function performPush(force: boolean, targetKey?: string): Promise<void> {
    setState({ syncing: true });
    // 批次中是否刷新过基准（首拉/成功/409 重取）：有才写回 localStorage。
    let baselineTouched = false;
    try {
      const keys = targetKey !== undefined ? [targetKey] : [...entries.keys()];
      for (const key of keys) {
        const e = entry(key);
        if (!e.dirty && !force) {
          continue;
        }
        // 冲突待人工合并的条目：自动推送不触碰（force 由用户确认后放行）。
        // 若不设这道闸，409 刷新基准后下一次本地变化会以新基准通过 CAS，
        // 在跨设备时钟偏差（LWW 误判本地较新）下静默覆盖他端更新。
        if (!force && e.awaitingMerge) {
          continue; // 保持 dirty，状态条「有冲突」待用户在对话框处理。
        }
        // 首推前先拉该船基准（乐观锁用服务器 updated_at，LWW 用 payload 时间戳）。
        if (e.remoteBaseUpdatedAt === 0) {
          const remote = await fetchChainSync(key);
          if (remote) {
            const remoteDoc = normalizeDoc(remote.payload);
            e.remoteBaseUpdatedAt = remote.updatedAt;
            e.remoteUpdatedAt = remoteDoc?.updatedAt ?? 0;
            // 首拉即见云端已清除某代际：记入本地 tombstone。
            if (remoteDoc?.clearedFp !== undefined) {
              e.clearedFp = remoteDoc.clearedFp;
            }
            baselineTouched = true;
          }
        }
        const localUpdatedAt = e.lastLocalChangeAt > 0 ? e.lastLocalChangeAt : Date.now();
        const doc =
          key === CONFIG_KEY
            ? collectConfigDoc(opts.getConfig(), localUpdatedAt)
            : collectShipDoc(key, localUpdatedAt, opts.resolveShipName, e.clearedFp);
        // 推送前同代拦截：本地 run 的代际 == 本端已知「云端已清除」的代际
        // （残留脚本被导入/重建）→ 直接移除本地，不推回云端。fp 每次 execute
        // 重新 mint，同代不可能是新的合法 run。此守卫在 base 已刷新（无 409）
        // 时仍生效，堵住「采纳清除后同代残留经 CAS 直接放行」的复活洞。
        if (!force && e.clearedFp !== undefined && doc.chainRuns[key]?.fp === e.clearedFp) {
          discardClearedGen(key, e.clearedFp);
          opts.onNotice?.(`${entryLabel(key)}为已清除代际的残留，已移除。`);
          continue;
        }
        // 内容与上次成功推送/拉取一致：这次标脏多半是粗粒度 watch 的误报，
        // 跳过并清脏，不推进云端时间戳——避免把未实际变化的内容以新时间戳
        // 推送上去，覆盖他端对同一条目的更新（架空 LWW 保护）。
        if (!force && e.pushedSignature !== null && e.pushedSignature === contentSignature(doc)) {
          e.dirty = false;
          continue;
        }
        // LWW：云端较新时拒绝上传，避免静默覆盖另一端（force 跳过）。
        if (!force && e.remoteUpdatedAt > localUpdatedAt) {
          e.awaitingMerge = true;
          setState({ conflict: true });
          opts.onNotice?.(
            `${entryLabel(key)}云端较新（${formatTime(e.remoteUpdatedAt)}），请先下拉。`,
          );
          continue; // 保持 dirty + awaitingMerge，等待人工处理。
        }
        let res = await pushChainSync(key, doc, e.remoteBaseUpdatedAt);
        if (!res.ok && force && res.latest) {
          // 用户已确认覆盖云端：以最新 base 重试一次。
          e.remoteBaseUpdatedAt = res.latest.updatedAt;
          e.remoteUpdatedAt = normalizeDoc(res.latest.payload)?.updatedAt ?? 0;
          baselineTouched = true;
          res = await pushChainSync(key, doc, e.remoteBaseUpdatedAt);
        }
        if (res.ok) {
          e.remoteBaseUpdatedAt = res.updatedAt;
          e.remoteUpdatedAt = doc.updatedAt;
          e.pushedSignature = contentSignature(doc);
          baselineTouched = true;
          e.dirty = false;
          e.awaitingMerge = false; // force 覆盖成功即视为解决该条目冲突。
          setState({ lastSyncAt: res.updatedAt, error: null });
          if (force) {
            opts.onNotice?.(`${entryLabel(key) || '配置'}已用本地覆盖云端。`);
          }
        } else {
          // 409 并发冲突：该船云端已被更新。先取最新快照核对内容是否一致。
          const latest = res.latest;
          if (latest) {
            const remoteDoc = normalizeDoc(latest.payload);
            e.remoteBaseUpdatedAt = latest.updatedAt;
            e.remoteUpdatedAt = remoteDoc?.updatedAt ?? 0;
            // 云端显示已清除某代际：记入本地 tombstone（采纳/收敛路径亦依赖）。
            if (remoteDoc?.clearedFp !== undefined) {
              e.clearedFp = remoteDoc.clearedFp;
            }
            baselineTouched = true;
            // ── 代际指纹规则（仅自动路径；force 为用户显式覆盖，不走）──
            if (!force && remoteDoc !== null) {
              const localRunFp = doc.chainRuns[key]?.fp;
              const remoteClearedFp = remoteDoc.clearedFp;
              if (localRunFp !== undefined && remoteClearedFp === localRunFp) {
                // 云端清除了本地持有的同一代 run（他端「清理计划」已落地）：
                // 本地这份是旧代——自动采纳删除，防止本端 stale 数据把它
                // 「复活」回云端。
                adoptRemote(key, remoteDoc, latest.updatedAt);
                opts.onNotice?.(`${entryLabel(key)}已在云端清除，本地已同步删除。`);
                continue;
              }
              const localClearedFp = doc.clearedFp;
              const remoteRunFp = remoteDoc.chainRuns[key]?.fp;
              if (localClearedFp !== undefined && remoteRunFp === localClearedFp) {
                // 本地显式清理了该代，但云端仍是被自动进度推送的同代 run：
                // 显式清理赢过自动推送——以最新 base 重推空快照一次。
                res = await pushChainSync(key, doc, e.remoteBaseUpdatedAt);
                if (res.ok) {
                  e.remoteBaseUpdatedAt = res.updatedAt;
                  e.remoteUpdatedAt = doc.updatedAt;
                  e.pushedSignature = contentSignature(doc);
                  e.dirty = false;
                  e.awaitingMerge = false;
                  setState({ lastSyncAt: res.updatedAt, error: null });
                  opts.onNotice?.(`${entryLabel(key) || '配置'}已用本地覆盖云端。`);
                  continue;
                }
                // 重推仍失败：落入下方统一 409 处理（内容收敛或冲突闸）。
              }
            }
            if (remoteDoc !== null && contentSignature(remoteDoc) === contentSignature(doc)) {
              // 双方内容一致（签名剔除 updatedAt 与触发器 id）：只是云端被
              // 同内容更新/重放，无实质分歧——收敛基准并清脏，不设冲突闸。
              e.pushedSignature = contentSignature(doc);
              e.dirty = false;
              e.awaitingMerge = false;
              setState({ lastSyncAt: latest.updatedAt, error: null });
            } else if (
              !force &&
              remoteDoc !== null &&
              doc.clearedFp !== undefined &&
              remoteDoc.chainRuns[key]?.fp !== doc.clearedFp
            ) {
              // 本地是「清理某代」的空快照，但云端已被更新的代际取代（新 run 或
              // 更新代的清除）：空快照无内容可合并——静默采纳云端基准并丢弃过期
              // 的清除意图，不制造假冲突（否则断线期间的清理会在每次启动补推时
              // 误报）。同代 run（remoteRunFp == clearedFp）已在上面由「显式清理
              // 赢过自动进度」处理，不会走到这里。
              const remoteCleared = remoteDoc.clearedFp;
              const remoteRun = remoteDoc.chainRuns[key]?.fp;
              e.clearedFp =
                remoteCleared !== undefined
                  ? remoteCleared
                  : remoteRun !== undefined
                    ? undefined
                    : e.clearedFp;
              e.pushedSignature = contentSignature(remoteDoc);
              e.dirty = false;
              e.awaitingMerge = false;
              setState({ lastSyncAt: latest.updatedAt, error: null });
            } else {
              // 实质分歧：标记「待人工合并」。此后自动推送跳过该条目，直到
              // 用户在对话框下拉或强制上传——防止 409 刷新基准后以本地时钟
              // 静默覆盖他端更新（时钟偏差下 LWW 会误判本地较新）。
              e.awaitingMerge = true;
              setState({ conflict: true });
              opts.onNotice?.(`${entryLabel(key)}上传冲突：云端较新，请先下拉。`);
            }
          }
        }
      }
      // 批次结束按实际剩余脏/待合并状态重算标志：
      // - 无脏 → 清 dirty + conflict；
      // - 仍有脏但无待合并 → 仅清 conflict（如新变化、网络错误）；
      // - 有待合并 → 保持/置位 conflict（不被同批其它条目成功推送掩盖）。
      const remaining = [...entries.values()];
      if (!remaining.some(x => x.dirty)) {
        setState({ dirty: false, conflict: false });
      } else {
        setState({ conflict: hasPendingMerge() });
      }
    } catch (e) {
      const msg = errorMessage(e);
      if (msg) {
        setState({ error: msg });
      }
    } finally {
      // 批次中可能刷新了基准（首拉/成功/409 重取），写回供跨会话使用。
      if (baselineTouched) {
        persistBaselines();
      }
      setState({ syncing: false });
    }
  }

  // 串行化推送：force（手动覆盖/清空远端）在自动推送在途时排队等待，
  // 而不是被静默丢弃（对话框此时已关闭，用户无法感知失败）。
  let activePush: Promise<void> | null = null;

  async function pushNow(force = false, targetKey?: string): Promise<void> {
    if (!started) {
      return;
    }
    while (activePush) {
      try {
        await activePush;
      } catch {
        // 前序批次错误已写入 state.error，继续执行本次。
      }
    }
    const run = performPush(force, targetKey);
    activePush = run;
    try {
      await run;
    } finally {
      if (activePush === run) {
        activePush = null;
      }
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

  // 应用远端到本地并收敛该条目基准（自动采纳清除 / 手动下拉共用）。
  // serverUpdatedAt：该条目服务端行时间（updated_at，CAS 乐观锁基准），
  // 未知时退回 payload 时间戳。
  function adoptRemote(shipId: string, doc: ChainSyncDoc, serverUpdatedAt: number): void {
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
    // 采纳远端清除：记录被清除的代际（空快照删除传播的本地 tombstone）。
    if (doc.clearedFp !== undefined) {
      e.clearedFp = doc.clearedFp;
    }
    e.lastLocalChangeAt = doc.updatedAt;
    // 落地后本地内容与云端一致：刷新乐观锁/LWW 基准与内容签名，避免下一次
    // 自动推送带着旧 base 触发假 409「云端较新，请先下拉」。
    e.remoteBaseUpdatedAt = serverUpdatedAt > 0 ? serverUpdatedAt : doc.updatedAt;
    e.remoteUpdatedAt = doc.updatedAt;
    // 签名以「落地后」的本地内容计算：applyShipDoc 会 stripDeletedActions 并
    // 重生成触发器 id，直接取远端 doc 会让下次收集结果与签名不一致而冗余推送。
    // （配置的 applyConfig 异步落地、无法同步取最终值，故配置直接用远端 doc；
    //  字段不全时最多冗余一次，随后签名与本地收敛。）
    const applied =
      shipId === CONFIG_KEY
        ? doc
        : collectShipDoc(shipId, doc.updatedAt, opts.resolveShipName, e.clearedFp);
    e.pushedSignature = contentSignature(applied);
    e.dirty = false;
    e.awaitingMerge = false; // 已收敛（下拉/云端清除），解除该条目的冲突闸。
    // 仅当没有其它条目仍待合并时才清 conflict。
    setState({ conflict: hasPendingMerge(), error: null });
    persistBaselines();
  }

  // 用户确认「用云端覆盖本地」（指定船或 '__config__'）。
  function confirmPull(shipId: string, doc: ChainSyncDoc, serverUpdatedAt: number): void {
    adoptRemote(shipId, doc, serverUpdatedAt);
    opts.onNotice?.(`已用云端覆盖${entryLabel(shipId) || '配置'}。`);
  }

  // 对比数据：本地（config + 各活跃船） vs 远端（config + 各船）。
  async function prepareComparison(): Promise<SyncComparison | null> {
    // 等在途推送结束再比较：避免对话框静默不弹或拿到推送中段的状态。
    while (activePush) {
      try {
        await activePush;
      } catch {
        // 前序批次错误已写入 state.error，继续。
      }
    }
    if (state.syncing) {
      // 另一个比较正在进行：放弃本次（避免叠加）。
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
          entry(shipId).clearedFp,
        );
        localShips.set(shipId, doc);
      }
      const localConfig = collectConfigDoc(
        opts.getConfig(),
        entry(CONFIG_KEY).lastLocalChangeAt > 0 ? entry(CONFIG_KEY).lastLocalChangeAt : Date.now(),
      );
      let remoteConfig: ChainSyncDoc | null = null;
      const remoteShips = new Map<string, ChainSyncDoc>();
      // 云端各条目服务端行时间（updated_at，CAS 乐观锁基准）。
      const remoteServerUpdatedAt = new Map<string, number>();
      for (const r of remotes) {
        const doc = normalizeDoc(r.payload);
        if (!doc) {
          continue;
        }
        remoteServerUpdatedAt.set(r.shipId, r.updatedAt);
        if (r.shipId === CONFIG_KEY) {
          remoteConfig = doc;
        } else {
          remoteShips.set(r.shipId, doc);
        }
      }
      return { localConfig, localShips, remoteConfig, remoteShips, remoteServerUpdatedAt };
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
    // 恢复跨会话遗留的「冲突待合并」条目：重载不丢闸，防止本地后续变化以
    // 刷新后的基准静默覆盖他端在离线期间的更新。同时置 dirty：让该条目在
    // hasPendingMerge() 中持续可见（冲突横幅不会因其它船的成功推送被误清），
    // 但门闩使其不被自动推送——只等用户在对话框手动处理。
    for (const key of Object.keys(persisted)) {
      if (persisted[key]?.merge) {
        const e = entry(key);
        e.awaitingMerge = true;
        e.dirty = true;
      }
    }
    if (hasPendingMerge()) {
      // 有待人工合并的条目：提示「有冲突」，引导打开对话框。
      setState({ dirty: true, conflict: true });
    }
    // 补推未落地的「清理」意图：本地无 run 且持久化记录了已清除代际（清理时
    // 离线、推送前重载等）→ 标脏触发一次空快照推送。已落地的会因内容签名一致
    // 在推送时被跳过（无网络请求）；被更新代际取代的会在 409 时静默收敛。
    for (const [key, saved] of Object.entries(persisted)) {
      if (key === CONFIG_KEY || saved?.cleared === undefined) {
        continue;
      }
      const e = entry(key);
      if (!e.awaitingMerge && userData.chainRuns[key] === undefined) {
        e.dirty = true;
      }
    }
    if ([...entries.values()].some(x => x.dirty && !x.awaitingMerge)) {
      setState({ dirty: true });
      schedulePush();
    }
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
    markShipCleared,
    pushNow,
    prepareComparison,
    confirmPull,
  };
}
