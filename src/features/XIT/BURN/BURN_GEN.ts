import GenerateActDialog from '@src/features/XIT/BURN/GenerateActDialog.vue';
import ExchangeGenerateActDialog from '@src/features/XIT/BURN/ExchangeGenerateActDialog.vue';

xit.add({
  command: 'BURNGEN',
  name: parameters => {
    if (parameters.length > 0) {
      return `生成 ACT 补充包 - ${parameters.join(' ')}`;
    }
    return '生成 ACT 补充包';
  },
  description: '为基地生成 ACT 补充包，或为 CX 交易所仓库生成 ACT 补库包。',
  mandatoryParameters: '星球名称或 CX <交易所代码>',
  component: parameters =>
    parameters[0]?.toUpperCase() === 'CX' ? ExchangeGenerateActDialog : GenerateActDialog,
  bufferSize: [500, 400],
});
