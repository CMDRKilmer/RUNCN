// 静默加油尝试的结局，用于向调用方（如 auto-refuel）通知本次尝试的结果。
export type RefuelResult =
  | { success: true }
  | {
      success: false;
      // 'no-fuel'：星球无燃料来源或来源库存不足；'other'：其他失败（超时等）。
      reason: 'no-fuel' | 'other';
    };
