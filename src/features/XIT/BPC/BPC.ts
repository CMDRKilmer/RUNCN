import BPC from './BPC.vue';

xit.add({
  command: 'BPC',
  name: '造船蓝图成本',
  description:
    '读取造船蓝图物料清单，统计每种配件在全部 CX 交易所的买入价，给出各交易所总价与最优混合采购成本。',
  component: () => BPC,
});
