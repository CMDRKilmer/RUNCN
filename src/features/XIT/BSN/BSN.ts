// 注册 XIT BSN 命令。
import BSN from '@src/features/XIT/BSN/BSN.vue';

xit.add({
  command: ['BSN', 'BASEALIAS'],
  name: '基地别名',
  description: '集中管理所有基地的自定义别名。',
  component: () => BSN,
});
