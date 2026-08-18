import ALERTS from '@src/features/XIT/ALERTS.vue';

xit.add({
  command: 'ALERTS',
  name: '提醒中心',
  description: '统一提醒中心：仓库租金、合同截止、CoGC 维护、选举、专家进度、产线停机。',
  component: () => ALERTS,
});
