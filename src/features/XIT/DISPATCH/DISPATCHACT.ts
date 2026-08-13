import DispatchActWindow from '@src/features/XIT/DISPATCH/DispatchActWindow.vue';

xit.add({
  command: 'DISPATCHACT',
  name: 'DISPATCH 执行',
  description: '执行已暂存的补给/维修操作包。',
  component: () => DispatchActWindow,
});
