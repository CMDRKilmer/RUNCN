import CXOS from '@src/features/XIT/CXOS/CXOS.vue';

xit.add({
  command: ['CXOS'],
  name: 'CX 挂单管理',
  description: '增强版 CX 挂单管理：图标显示、筛选、统计总览、一键跳转 CXPO。',
  component: () => CXOS,
});
