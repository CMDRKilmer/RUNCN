// 注册 XIT CBUY 命令（购物车购买表）。
import BuyTable from '@src/features/XIT/CART/BuyTable.vue';

xit.add({
  command: 'CBUY',
  name: '购物车购买表',
  description:
    '读取 XIT CART 购物车物品清单，统计每种物品在各 CX 交易所的买入价，给出各交易所总价与最优混合采购成本。',
  contextItems: () => [{ cmd: 'XIT CART' }],
  component: () => BuyTable,
});
