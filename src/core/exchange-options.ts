import { userData } from '@src/store/user-data';

// 冷门交易所：CI2（Arclight）与 NC2（Hubur）。默认不出现在任何交易所选择列表里，
// 因为多数玩家只在 AI1 / CI1 / IC1 / NC1 采购；需要时可在 XIT SET → 游戏设置 里打开。
const RARE_EXCHANGE_CODES = new Set(['CI2', 'NC2']);

/** 按用户设置过滤交易所列表：默认隐藏 CI2 / NC2，打开开关后原样返回。 */
export function withOptionalRareExchanges(options: readonly string[]): string[] {
  if (userData.settings.showRareExchanges) {
    return [...options];
  }
  return options.filter(x => !RARE_EXCHANGE_CODES.has(x));
}
