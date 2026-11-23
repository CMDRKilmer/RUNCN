import type { BurnValues } from '@src/core/burn';
import type { NativeRouteRecord } from '@src/features/XIT/FLEET/native-route-registry';
import type { BurnReportRow } from './utils';

export function filterBurnValues(burn: BurnValues, production: boolean, workforce: boolean) {
  const filtered: BurnValues = {};
  for (const [ticker, mat] of Object.entries(burn)) {
    if ((production && (mat.input > 0 || mat.output > 0)) || (workforce && mat.workforce > 0)) {
      filtered[ticker] = mat;
    }
  }
  return filtered;
}

function burnDays(dailyAmount: number, inventory: number) {
  // 消耗显示为 0.00 时沿用 BURN 总览的无限天数口径。
  return dailyAmount >= 0 || Math.abs(dailyAmount) < 0.005 ? Infinity : inventory / -dailyAmount;
}

export function mergeBurnValues(burns: readonly BurnValues[]) {
  const totals: BurnValues = {};
  for (const burn of burns) {
    for (const [ticker, mat] of Object.entries(burn)) {
      const total = (totals[ticker] ??= {
        input: 0,
        output: 0,
        workforce: 0,
        dailyAmount: 0,
        remainingAllocation: 0,
        inventory: 0,
        daysLeft: 0,
        type: 'output',
      });
      total.input += mat.input;
      total.output += mat.output;
      total.workforce += mat.workforce;
      total.inventory += mat.inventory;
      total.remainingAllocation += mat.remainingAllocation;
    }
  }
  for (const mat of Object.values(totals)) {
    mat.dailyAmount = mat.output - mat.input - mat.workforce;
    mat.daysLeft = burnDays(mat.dailyAmount, mat.inventory + mat.remainingAllocation);
  }
  return totals;
}

export function exchangeBurn(
  origin: string,
  routes: readonly { record: NativeRouteRecord; running: boolean }[],
  findBase: (location: string) => { siteId: string; burn: BurnValues | undefined } | undefined,
  stock: Readonly<Record<string, number>> | undefined,
): Record<string, BurnReportRow> | undefined {
  const locations = new Set<string>();
  for (const { record, running } of routes) {
    if (running && record.repeats === true) {
      const stops = record.waypoints.map(x => x.location.trim().toUpperCase());
      if (stops.includes(origin)) {
        for (const stop of stops) {
          locations.add(stop);
        }
      }
    }
  }
  const burns = new Map<string, BurnValues>();
  for (const location of locations) {
    const base = findBase(location);
    if (base === undefined || burns.has(base.siteId)) {
      continue;
    }
    if (base.burn === undefined) {
      return undefined;
    }
    burns.set(base.siteId, base.burn);
  }

  return Object.fromEntries(
    Object.entries(mergeBurnValues([...burns.values()])).map(([ticker, mat]) => {
      const inventory = stock === undefined ? undefined : (stock[ticker] ?? 0);
      return [
        ticker,
        {
          ...mat,
          inventory,
          remainingAllocation: 0,
          daysLeft: inventory === undefined ? undefined : burnDays(mat.dailyAmount, inventory),
        },
      ];
    }),
  );
}
