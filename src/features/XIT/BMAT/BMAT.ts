// 注册 XIT BMAT 命令（建材购买表）。
import BMAT from '@src/features/XIT/BMAT/BMAT.vue';

xit.add({
  command: 'BMAT',
  name: '建材购买表',
  description:
    '从 JH 已保存的基地计划读取建材需求，统计每种建材在各 CX 交易所的买入价，给出各交易所总价与最优混合采购成本。',
  contextItems: () => [{ cmd: 'XIT JH' }],
  component: () => BMAT,
});
