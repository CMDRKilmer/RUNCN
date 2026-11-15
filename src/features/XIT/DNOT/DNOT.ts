import DNOT from '@src/features/XIT/DNOT/DNOT.vue';

xit.add({
  command: ['DNOT', 'NOTIFY'],
  name: '桌面通知',
  description:
    '列出全部可推送的游戏通知类型，只有勾选的类型才会推送到浏览器桌面通知；支持按组批量开启与搜索。',
  bufferSize: [760, 620],
  component: () => DNOT,
});
