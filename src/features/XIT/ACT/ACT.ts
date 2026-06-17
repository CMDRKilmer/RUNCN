import './actions/cx-buy/cx-buy';
import './actions/mtra/mtra';
import './actions/refuel/refuel';

import './material-groups/repair/repair';
import './material-groups/resupply/resupply';
import './material-groups/manual/manual';

import ACT from '@src/features/XIT/ACT/ACT.vue';

xit.add({
  command: ['ACT', 'ACTION'],
  name: parameters => {
    if (parameters.length === 0) {
      return '操作包列表';
    }
    if (parameters[0].toUpperCase() == 'GEN' || parameters[0].toUpperCase() == 'EDIT') {
      return '编辑操作包';
    }
    return '执行操作包';
  },
  description: '允许自动化某些任务。',
  optionalParameters: 'GEN 和/或操作名称',
  contextItems: parameters => (parameters.length > 0 ? [{ cmd: 'XIT ACT' }] : []),
  component: () => ACT,
});
