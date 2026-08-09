import '@src/features/XIT/ACT/actions/cx-buy/cx-buy';
import '@src/features/XIT/ACT/actions/mtra/mtra';
import '@src/features/XIT/ACT/material-groups/repair/repair';

import RepairActWindow from '@src/features/XIT/REP/RepairActWindow.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'REPAIRACT',
  name: parameters => {
    const baseName = getI18nValue('RP.XIT.REPAIRACT.name', 'REPAIR ACTION');
    if (parameters[0]) {
      const site = sitesStore.getByPlanetNaturalIdOrName(parameters[0]);
      const name = site ? getEntityNameFromAddress(site.address) : parameters[0];
      return `${baseName} - ${name}`;
    }
    return baseName;
  },
  description: getI18nValue(
    'RP.XIT.REPAIRACT.description',
    'Executes a repair action package for a planet using XIT REP settings.',
  ),
  component: () => RepairActWindow,
});
