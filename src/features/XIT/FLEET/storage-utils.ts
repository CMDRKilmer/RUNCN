import { fixed01 } from '@src/utils/format';
import { computeNeed, getPlanetBurn, getResupplyDays } from '@src/core/burn';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

// 天数 ≥ 1000 在 UI 上折叠为"∞",避免长数字遮挡布局。
export function formatDays(days: number): string {
  if (!isFinite(days) || days >= 1000) {
    return '∞';
  }
  return fixed01(days);
}

// 超过 100 天的具体数字不再有意义,渲染为 "100+"。
export function formatDaysCompact(days: number): string {
  if (!isFinite(days) || days >= 1000) {
    return '∞';
  }
  if (days > 100) {
    return '100+';
  }
  return fixed01(days);
}

// 根据填充比例返回 CSS 类名,复用 PrUn 的 Workforce 配色板。
export function fillRatioClass(ratio: number): string {
  if (ratio >= 0.95) {
    return C.Workforces.daysMissing;
  }
  if (ratio >= 0.8) {
    return C.Workforces.daysWarning;
  }
  return C.Workforces.daysSupplied;
}

// 库存分析面板的物料明细行。原 BaseDetailPanel 内的逻辑提取为纯函数,
// 便于在不渲染面板的场景(如未来其他模块)也能复用。
export interface StorageMaterialRow {
  ticker: string;
  weight: number;
  volume: number;
  amount: number;
}

// 可运出(库存>0 且日产出<=0):基地实际想运走的产出物。
export function getShippingOutRows(siteId: string): StorageMaterialRow[] {
  const pb = getPlanetBurn(siteId);
  if (!pb) {
    return [];
  }
  const rows: StorageMaterialRow[] = [];
  for (const ticker of Object.keys(pb.burn)) {
    const mb = pb.burn[ticker];
    if (mb.dailyAmount <= 0 || mb.inventory <= 0) {
      continue;
    }
    const mat = materialsStore.getByTicker(ticker);
    if (!mat) {
      continue;
    }
    rows.push({
      ticker,
      amount: mb.inventory,
      weight: mb.inventory * mat.weight,
      volume: mb.inventory * mat.volume,
    });
  }
  rows.sort((a, b) => b.weight - a.weight);
  return rows;
}

// 补给需求:按基地的补给目标天数计算每种物资的 need,
// amount × 单物资重量/体积 = 该物资运入后的占用。
export function getResupplyRows(naturalId: string, siteId: string): StorageMaterialRow[] {
  const pb = getPlanetBurn(siteId);
  if (!pb) {
    return [];
  }
  const resupply = getResupplyDays(naturalId) ?? 0;
  const rows: StorageMaterialRow[] = [];
  for (const ticker of Object.keys(pb.burn)) {
    const mb = pb.burn[ticker];
    const need = computeNeed(mb, resupply);
    if (need <= 0) {
      continue;
    }
    const mat = materialsStore.getByTicker(ticker);
    if (!mat) {
      continue;
    }
    rows.push({
      ticker,
      amount: need,
      weight: need * mat.weight,
      volume: need * mat.volume,
    });
  }
  rows.sort((a, b) => b.weight - a.weight);
  return rows;
}
