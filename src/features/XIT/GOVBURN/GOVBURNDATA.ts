import '@src/features/XIT/ACT/actions/govburn-data/govburn-data';

import GovBurnDataWindow from '@src/features/XIT/GOVBURN/GovBurnDataWindow.vue';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';

xit.add({
  command: 'GOVBURNDATA',
  name: parameters => {
    // Join in case a naturalId/name was split by the XIT router.
    const parameter = parameters.join(' ');
    if (parameter) {
      const planet = planetsStore.find(parameter);
      return `GOVBURN DATA - ${planet?.name ?? parameter}`;
    }
    return 'GOVBURN DATA';
  },
  description: 'Collects planetary infrastructure upkeep data via POPI/POPID buffers.',
  optionalParameters: 'Planet Identifier',
  component: () => GovBurnDataWindow,
});
