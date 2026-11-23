import { computeNeed } from '@src/core/burn';
import type { BurnReportRow } from './utils';

export function burnReportNeed(burn: BurnReportRow, targetDays: number) {
  const { dailyAmount, inventory } = burn;
  return dailyAmount === undefined || inventory === undefined
    ? undefined
    : computeNeed({ dailyAmount, inventory }, targetDays);
}

export function exchangeBurnNeeds(burn: Record<string, BurnReportRow>, targetDays: number) {
  const needs: Record<string, number> = {};
  for (const [ticker, row] of Object.entries(burn)) {
    const amount = burnReportNeed(row, targetDays);
    if (amount === undefined) {
      return undefined;
    }
    if (amount > 0 && Number.isFinite(amount)) {
      needs[ticker] = amount;
    }
  }
  return needs;
}
