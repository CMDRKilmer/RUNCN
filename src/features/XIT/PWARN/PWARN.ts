import PWARN from '@src/features/XIT/PWARN/PWARN.vue';

xit.add({
  command: 'PWARN',
  name: '停机预警',
  description: '跨基地产线停机与产能空闲预警。',
  component: () => PWARN,
});
