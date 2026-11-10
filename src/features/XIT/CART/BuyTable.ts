// 注册 XIT CBUY 命令（购物车购买表 / BURN 采购比价）。
import BuyTable from '@src/features/XIT/CART/BuyTable.vue';

xit.add({
  command: 'CBUY',
  name: parameters => (parameters[0] ? `采购比价 - ${parameters[0]}` : '购物车购买表'),
  description:
    '默认读取 XIT CART 购物车清单，统计各 CX 交易所买入价并给出最优混合采购成本；带星球编码时（XIT CBUY <星球>）改用该星球 XIT BURN 的「需要」列临时比价，不改动购物车。',
  optionalParameters: '星球编码（BURN 比价）；留空则使用 XIT CART 购物车',
  contextItems: () => [{ cmd: 'XIT CART' }],
  // 4 个交易所卡片并排不换行的最小可用宽度：卡片 132px × 4 + 3 个 6px 间距
  // ≈ 546px，再加窗口内边距与右侧滚动条；高度给足表格可见行数。
  bufferSize: [700, 560],
  component: () => BuyTable,
});
