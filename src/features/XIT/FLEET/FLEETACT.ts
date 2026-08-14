import FleetActWindow from '@src/features/XIT/FLEET/FleetActWindow.vue';

xit.add({
  command: 'FLEETACT',
  name: '基地管理 执行',
  description: '执行已暂存的补给/维修操作包。',
  component: () => FleetActWindow,
});
