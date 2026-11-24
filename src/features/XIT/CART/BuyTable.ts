// 注册 XIT CBUY 命令（购物车购买表 / BURN 采购比价 / REPD 维修清单比价 / GOVH 政府基建补给比价）。
import BuyTable from '@src/features/XIT/CART/BuyTable.vue';
import { REPD_QUOTE_PARAM } from '@src/features/XIT/CART/repair-quote';
import { GOVH_QUOTE_PARAM } from '@src/features/XIT/GOVH/govh-quote';

xit.add({
  command: 'CBUY',
  name: parameters => {
    if (parameters[0] === REPD_QUOTE_PARAM) {
      return '采购比价 - 维修清单';
    }
    if (parameters[0] === GOVH_QUOTE_PARAM) {
      return '采购比价 - 政府基建补给';
    }
    if (parameters[0]?.toUpperCase() === 'CX') {
      return `采购比价 - CX ${parameters[1] ?? ''}`.trimEnd();
    }
    return parameters[0] ? `采购比价 - ${parameters[0]}` : '购物车购买表';
  },
  description:
    '用游戏盘口为购物车、基地 BURN、CX BURN、维修或政府补给清单比价。XIT CBUY CX <交易所代码> 按该 CX BURN 的「需要」列比价，ACT 在该 CX 补库。基地 BURN 与 GOVH 比价默认转移到飞船，基地 BURN 同时预填航行控制。',
  optionalParameters: '星球编码、CX <交易所代码>、REPD 或 GOVH。留空则使用 XIT CART 购物车。',
  contextItems: () => [{ cmd: 'XIT CART' }],
  // 4 个交易所卡片并排不换行的最小可用宽度：卡片 132px × 4 + 3 个 6px 间距
  // ≈ 546px，再加窗口内边距与右侧滚动条；高度给足表格可见行数。
  bufferSize: [700, 560],
  component: () => BuyTable,
});
