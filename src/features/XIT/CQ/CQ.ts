import CQ from '@src/features/XIT/CQ/CQ.vue';

xit.add({
  command: 'CQ',
  name: '他人挂单查询',
  description:
    '按公司代码/名称/用户名查其在全部 CX 交易所的挂单与本地市场(LM)广告。数据来自 FIO，非游戏实时全量。',
  optionalParameters: '公司代码或名称或用户名',
  component: () => CQ,
  bufferSize: [820, 560],
});
