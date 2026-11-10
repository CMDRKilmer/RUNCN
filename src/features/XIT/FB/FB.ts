import FB from '@src/features/XIT/FB/FB.vue';

xit.add({
  command: ['ABCC', 'FB', 'BASES'],
  name: '全基地控制中心',
  description:
    '一屏管理全部基地（All Bases Control Center）：FLEET 基地列表 + BS 概况 + INV 仓库 + BURN 消耗品 + FLT 舰队 + SHPI 舰船货舱。子磁贴由本命令自行开齐，新建缓存窗口输入 XIT ABCC 即可完整显示，也可固定成游戏内标签页；原有 XIT FB / XIT BASES 保留为兼容命令。',
  bufferSize: [1500, 900],
  component: () => FB,
});
