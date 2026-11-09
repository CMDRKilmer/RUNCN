import BPC from './BPC.vue';

xit.add({
  command: 'BPC',
  name: '造船蓝图成本',
  description:
    '读取造船蓝图物料清单，统计每种配件在全部 CX 交易所的买入价，给出各交易所总价与最优混合采购成本。',
  contextItems: () => [{ cmd: 'BLU' }, { cmd: 'SHYP' }],
  // 与 XIT CBUY 同步：4 张交易所卡片（132px × 4 + 3 个 6px 间距 ≈ 546px）
  // 排成一行不折行，金额也能完整显示。
  bufferSize: [700, 560],
  component: () => BPC,
});
