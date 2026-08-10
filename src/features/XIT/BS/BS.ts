import BS from '@src/features/XIT/BS/BS.vue';

xit.add({
  command: 'BS',
  name: '基地总览',
  description: '列出所有玩家基地并提供关键子命令链接。',
  optionalParameters: '行星标识',
  component: () => BS,
  bufferSize: [660, 300],
});
