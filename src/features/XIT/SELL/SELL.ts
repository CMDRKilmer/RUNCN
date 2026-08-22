import SELL from '@src/features/XIT/SELL/SELL.vue';
import { initDragImport } from '@src/features/XIT/SELL/drag-import';

initDragImport();

xit.add({
  command: 'SELL',
  name: '批量售卖',
  description: '读取四大交易所 CX 仓库库存，批量挂单或填单售卖。',
  component: () => SELL,
});
