import { userData } from '@src/store/user-data';
import { createId } from '@src/store/create-id';

// XIT 命令参数仅接受 ASCII（与 BPC/CART 生成 ACT 同款约束）：包名会拼进
// `XIT ACT_${name}` 命令，含中文 / `()'"&` 等符号时 PrUn 端解析失败（提示无效指令）。
// 仅保留 ASCII 字母 / 数字 / hyphen，其余符号与空白折叠为单个空格。
export function sanitizeActName(name: string): string {
  return name
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 环线代际指纹 ──────────────────────────────────────────────
// 每次 execute() 生成环线时铸入一枚 10 位 hex 指纹，追加在各 ACT 包/触发器名
// 末尾（` <fp>`）。它是该环线 run 的「代际身份」：船改名、船名互为后缀都不再
// 影响归属；云端同步用它判定「同一代已被他端清除」以防止旧数据复活。
export function mintChainFp(): string {
  return createId().slice(0, 10);
}
// 名称末尾指纹后缀（含前导空格，ASCII 安全、可过 sanitizeActName）。
export function chainFpSuffix(fp: string): string {
  return ` ${fp}`;
}
// 环线 ACT 包名长度上限（含空格与 fp 后缀）：保守值。XIT/PrUn 侧命令/包名
// 过长会解析失败，超长船名/星球名 + fp 是最可能的来源；超限时压缩可变段。
export const MAX_CHAIN_PKG_NAME = 80;
// 超限时压缩包名：保留数字前缀/类型关键字所在的前段与末尾 fp 后缀（fp 必须
// 原样保留——它是归属/代际匹配锚点），裁剪中间的可变段。无 fp 后缀时兜底截断。
export function fitChainPkgName(name: string): string {
  if (name.length <= MAX_CHAIN_PKG_NAME) {
    return name;
  }
  const fpMatch = /^(.*?)\s+([0-9a-f]{10})$/.exec(name);
  if (fpMatch === null) {
    return name.slice(0, MAX_CHAIN_PKG_NAME).trim();
  }
  const body = fpMatch[1]!;
  const fp = fpMatch[2]!;
  const bodyBudget = MAX_CHAIN_PKG_NAME - 1 - fp.length;
  return `${body.slice(0, bodyBudget).trimEnd()} ${fp}`;
}

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
