import ELEC from '@src/features/XIT/ELEC/ELEC.vue';

xit.add({
  command: 'ELEC',
  name: '选举',
  description: '显示你设有基地的星球上即将举行的选举。',
  component: () => ELEC,
});
