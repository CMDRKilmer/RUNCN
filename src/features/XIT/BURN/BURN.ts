import BURN from '@src/features/XIT/BURN/BURN.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';

xit.add({
  command: 'BURN',
  name: parameters => {
    if (parameters[0]?.toUpperCase() === 'CX') {
      return parameters[1] ? `消耗品报告 - CX ${parameters[1]}` : 'CX 消耗品报告';
    }
    if (parameters[0] && !parameters[1]) {
      const site = sitesStore.getByPlanetNaturalIdOrName(parameters[0]);
      if (site) {
        const name = getEntityNameFromAddress(site.address);
        return `消耗品报告 - ${name}`;
      }
    }

    return '消耗品报告';
  },
  description: '显示基地消耗品剩余天数，或按 CX 汇总运行中循环航线的仓库消耗。',
  optionalParameters: '星球标识符, OVERALL, NOT, CX <交易所代码>',
  component: () => BURN,
});
