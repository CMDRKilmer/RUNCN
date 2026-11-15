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
    return parameters[0] ? `采购比价 - ${parameters[0]}` : '购物车购买表';
  },
  description:
    '默认读取 XIT CART 购物车清单，统计各 CX 交易所买入价并给出最优混合采购成本；带星球编码时（XIT CBUY <星球>）改用该星球 XIT BURN 的「需要」列临时比价；XIT CBUY REPD 比价 XIT REPD 当前勾选的维修购物清单；XIT CBUY GOVH 比价 XIT GOVH 选中的政府基建补给清单。三种临时清单都不改动购物车，并会按游戏本地仓库库存抵扣：扣掉所选交易所仓库（REPD 另扣被维修基地仓库）已有材料后才是采购量，ACT 只买差额、MTRA 仍转移完整需求。BURN 与 GOVH 比价默认勾选「转移到飞船」并预填目的地（BURN 额外自动打开航行控制）。',
  optionalParameters:
    '星球编码（BURN 比价）、REPD（维修清单比价）或 GOVH（政府基建补给比价）；留空则使用 XIT CART 购物车',
  contextItems: () => [{ cmd: 'XIT CART' }],
  // 4 个交易所卡片并排不换行的最小可用宽度：卡片 132px × 4 + 3 个 6px 间距
  // ≈ 546px，再加窗口内边距与右侧滚动条；高度给足表格可见行数。
  bufferSize: [700, 560],
  component: () => BuyTable,
});
