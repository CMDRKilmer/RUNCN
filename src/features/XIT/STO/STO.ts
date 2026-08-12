import STO from '@src/features/XIT/STO/STO.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';

xit.add({
  command: ['STO', 'STORAGE'],
  name: parameters => {
    if (parameters[0]) {
      const site = sitesStore.getByPlanetNaturalIdOrName(parameters[0]);
      if (site) {
        return `仓储分析 — ${getEntityNameFromAddress(site.address)}`;
      }
    }
    return '仓储分析';
  },
  description:
    '按基地展示仓储分析:当前填充率、按当前生产速率推算的填满天数,以及由你的船队推出的访问频率。',
  optionalParameters: '行星',
  component: () => STO,
  bufferSize: [900, 500],
});
