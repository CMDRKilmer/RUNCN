// 补给天数容量上限（suppliesCapDays）的读取与钳制工具。
// 汇总以下调用点（改本文件语义时逐个复核）：
//   - PlanetRow.vue 天数输入框 watch / inputDaysCap / daysTooltip
//   - FLEET.vue planConfig / chainConfig：「填满库存」开关下每天的天数口径
//   - utils.ts computeResupplyBill（按物料钳制）与 fitDaysForShip（取补给基地 cap 的最大值）
//   - chain-data.ts 输入快照的目标天数；CART/BuyTable.vue、BURN/MaterialRow.vue 的目标天数
//   - use-chain-planning.ts 环线的补给容量上限
// 语义统一：cap 未定义或非有限数 → Infinity（不限制）；天数钳制为
//   max(0, min(days, cap))。UI 输入框额外做两位小数向下截断（与适配精度对齐）。

import { getBaseStorageAnalysis } from '@src/core/storage-analysis';

/** 归一化容量上限：undefined / NaN / Infinity 一律视为不限制。 */
export function normalizeSuppliesCap(capDays: number | undefined): number {
  return capDays === undefined || !isFinite(capDays) ? Infinity : capDays;
}

/** 从基地 site 读取补给容量上限（天）。 */
export function getSuppliesCap(site: PrunApi.Site | undefined): number {
  return normalizeSuppliesCap(site ? getBaseStorageAnalysis(site)?.suppliesCapDays : undefined);
}

/**
 * 「填满库存」开关下每天实际使用的计划天数。
 * fittedDays = 该船按剩余容量能装的补给天数（fitDaysForShip 的结果，可能已取多基地上限的最大值）；
 * capDays = 本基地仓储上限（getSuppliesCap：未加载/非有限数 → Infinity）。
 * 未适配（无船/船不在 CX/缺货舱）时退回仓储上限，无上限则保留手填天数。
 * 适配值还要按本基地 cap 再钳一次：同一艘船挂多个补给基地时，饱和点取的是各基地 cap 的最大值，
 * 不钳就会出现「目标 40 天 > 本基地仓储上限 25 天」的自相矛盾（账单本就会逐基地钳一次）。
 */
export function fillInventoryDays(
  fittedDays: number | undefined,
  capDays: number,
  manualDays: number,
) {
  if (fittedDays === undefined) {
    return Number.isFinite(capDays) ? capDays : manualDays;
  }
  return Math.min(fittedDays, capDays);
}

/** 钳制目标天数到容量上限内（保留精度）。 */
export function clampTargetDays(days: number, capDays: number | undefined): number {
  return Math.max(0, Math.min(days, normalizeSuppliesCap(capDays)));
}

/**
 * UI 输入钳制：只在上限为正且超过时向下取两位小数截断。
 * cap <= 0 时不改动，保留用户输入（防止仓储被堆满时把天数锁死为 0）。
 */
export function clampDaysInput(days: number, capDays: number | undefined): number {
  const cap = normalizeSuppliesCap(capDays);
  if (cap > 0 && days > cap) {
    return Math.floor(cap * 100) / 100;
  }
  return days;
}

// Search in hundredths of a day, expanding the upper bound for bases without a storage limit.
export function fitTargetDays(cap: number, fits: (days: number) => boolean): number | undefined {
  if (Number.isFinite(cap) && fits(cap)) {
    return cap;
  }
  if (!fits(0)) {
    return 0;
  }

  let upper = Math.floor(cap * 100);
  if (!Number.isSafeInteger(upper)) {
    upper = 100;
    while (fits(upper / 100)) {
      upper *= 2;
      if (!Number.isSafeInteger(upper)) {
        return undefined;
      }
    }
  }

  let lower = 0;
  while (lower < upper) {
    const middle = lower + Math.ceil((upper - lower) / 2);
    if (fits(middle / 100)) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return lower / 100;
}
