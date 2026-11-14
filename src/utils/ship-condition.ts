// 舰船耐久（维修阈值）分级 —— XIT FLT 的船况告警与 FLEET 左侧船名共用这一套口径，
// 避免两处各内联一份阈值、改一半对不齐（见 docs/theme-framework.md R50）。
//
// 分级：0.80 ~ 0.83（含两端）临近维修；低于 0.80 已到维修临界。
// 刻意零依赖：Node 端的回归脚本（scripts/test-ship-condition.mjs）要直接驱动它。
export type ShipConditionLevel = 'ok' | 'warn' | 'danger';

export const SHIP_CONDITION_WARN_MAX = 0.83;
export const SHIP_CONDITION_DANGER_BELOW = 0.8;

export function shipConditionLevel(condition: number): ShipConditionLevel {
  if (condition < SHIP_CONDITION_DANGER_BELOW) {
    return 'danger';
  }
  if (condition <= SHIP_CONDITION_WARN_MAX) {
    return 'warn';
  }
  return 'ok';
}
