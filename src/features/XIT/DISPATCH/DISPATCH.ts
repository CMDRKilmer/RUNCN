import DISPATCH from '@src/features/XIT/DISPATCH/DISPATCH.vue';

xit.add({
  command: 'DISPATCH',
  name: 'DISPATCH',
  description: '舰队级补给与维修规划器。',
  component: () => DISPATCH,
  bufferSize: [800, 500],
});
