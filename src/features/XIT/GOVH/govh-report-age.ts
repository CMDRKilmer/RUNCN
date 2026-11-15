// POPR 报告年龄解析 + 周期缓存剩余时长。
//
// 人口 / 幸福度 / 六类满足度在一个报告周期（7 天整）内固定，只有跨周期才变。
// 面板用 POPR 顶部「报告#43/5天 13小时前」反推本期结束时刻，周期内复用缓存。
//
// 关键点：这个标签只精确到小时（或分钟），**不是精确时间戳**。
// 读到「6天 23小时前」时，真实年龄可能在 6天23小时0分到 6天23小时59分之间，
// 也就是说随时可能已经 rollover。若把解析值当成精确年龄，缓存会活到新周期
// 开始后近一小时，那段时间里上一期的人口 / 满足度会和新读的 LR / POPID 混在一起，
// 算出错误的采购方案（PR #60 审查）。
//
// 所以剩余时长按**年龄区间上界**算：7天 − 年龄 − 该文本的取整精度。
// 宁可早一点失效（多开一次 POPR 窗口），也不要把上一期数据带进新周期。

// 人口报告周期，7 天整。
export const REPORT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface ReportAge {
  ageMs: number;
  // 该文本的取整粒度：真实年龄一定落在 [ageMs, ageMs + precisionMs) 内。
  precisionMs: number;
}

// 「报告#43/5天 13小时前」「报告#43/6天前」「报告#43/3小时前」「报告#43/12分钟前」。
// 解析不出来（如「刚刚」）返回 undefined，此时不写缓存，保持每次重读。
export function parseReportAge(label: string | undefined): ReportAge | undefined {
  if (label === undefined) {
    return undefined;
  }
  const text = label.replace(/\s+/g, ' ');
  const cnDayHour = /(\d+)\s*天\s*(\d+)\s*小时/.exec(text);
  if (cnDayHour) {
    return {
      ageMs: (Number(cnDayHour[1]) * 24 + Number(cnDayHour[2])) * HOUR_MS,
      precisionMs: HOUR_MS,
    };
  }
  const enDayHour = /(\d+)\s*d(?:ays?)?\s*(\d+)\s*h/i.exec(text);
  if (enDayHour) {
    return {
      ageMs: (Number(enDayHour[1]) * 24 + Number(enDayHour[2])) * HOUR_MS,
      precisionMs: HOUR_MS,
    };
  }
  // 「6天前」这种只到天的写法：精度是一整天，宁可早失效。
  const dayOnly = /(\d+)\s*(?:天|d(?:ays?)?\b)/i.exec(text);
  if (dayOnly) {
    return { ageMs: Number(dayOnly[1]) * DAY_MS, precisionMs: DAY_MS };
  }
  const hour = /(\d+)\s*(?:小时|h)/i.exec(text);
  if (hour) {
    return { ageMs: Number(hour[1]) * HOUR_MS, precisionMs: HOUR_MS };
  }
  const minute = /(\d+)\s*(?:分钟|min)/i.exec(text);
  if (minute) {
    return { ageMs: Number(minute[1]) * MINUTE_MS, precisionMs: MINUTE_MS };
  }
  return undefined;
}

// 缓存还能用多久。<= 0 表示「现在就该重读」，调用方不要写缓存。
export function reportCacheRemainingMs(age: ReportAge): number {
  return REPORT_CYCLE_MS - age.ageMs - age.precisionMs;
}
