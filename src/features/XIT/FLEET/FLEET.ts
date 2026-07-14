import FLEET from '@src/features/XIT/FLEET/FLEET.vue';

xit.add({
  command: 'FLEET',
  name: '舰队分布',
  description: '按目的地分组的舰队分布与状态总览。',
  component: () => FLEET,
});
