import NativeRouteWindow from '@src/features/XIT/FLEET/NativeRouteWindow.vue';

xit.add({
  command: 'RTWIZ',
  name: '原生航线向导',
  description: '为选中的船只创建原生 RT：计算各段燃料档位、按产业链命名并写入航点与步骤。',
  component: () => NativeRouteWindow,
  bufferSize: [560, 620],
});
