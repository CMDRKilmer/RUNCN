import WFOR from '@src/features/XIT/WFOR/WFOR.vue';

xit.add({
  command: 'WFOR',
  name: '劳动力',
  description: '跨基地劳动力满足度与必需品缺口总览。',
  component: () => WFOR,
});
