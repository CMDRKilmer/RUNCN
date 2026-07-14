import SHPT from '@src/features/XIT/SHPT/SHPT.vue';

xit.add({
  command: 'SHPT',
  name: '在途货物',
  description: '运输合同在途货物追踪与到货倒计时。',
  component: () => SHPT,
});
