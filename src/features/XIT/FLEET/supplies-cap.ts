// 补给天数容量上限（suppliesCapDays）的读取与钳制工具。
// 汇总四处重复逻辑：
//   - PlanetRow.vue 输入框 watch / inputDaysCap / daysTooltip
//   - chain-planner.ts clampTargetDays
//   - utils.ts computeResupplyBill / fitDaysForShip
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

/** 钳制目标天数到容量上限内（保留精度）。 */
export function clampTargetDays(days: number, capDays: number | undefined): number {
  return Math.max(0, Math.min(days, normalizeSuppliesCap(capDays)));
}

/**
 * UI 输入钳制：只在上限为正且超过时向下取两位小数截断（与 fitDaysForShip 精度一致）。
 * cap <= 0 时不改动，保留用户输入（防止仓储被堆满时把天数锁死为 0）。
 */
export function clampDaysInput(days: number, capDays: number | undefined): number {
  const cap = normalizeSuppliesCap(capDays);
  if (cap > 0 && days > cap) {
    return Math.floor(cap * 100) / 100;
  }
  return days;
}
