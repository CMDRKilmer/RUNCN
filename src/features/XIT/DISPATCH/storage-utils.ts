import { fixed01 } from '@src/utils/format';

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