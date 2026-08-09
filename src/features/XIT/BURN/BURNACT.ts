import '@src/features/XIT/ACT/actions/cx-buy/cx-buy';
import '@src/features/XIT/ACT/actions/mtra/mtra';
import '@src/features/XIT/ACT/material-groups/resupply/resupply';

import BurnActWindow from '@src/features/XIT/BURN/BurnActWindow.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'BURNACT',
  name: parameters => {
    const baseName = getI18nValue('RP.XIT.BURNACT.name', 'BURN RESUPPLY');
    if (parameters[0]) {
      const site = sitesStore.getByPlanetNaturalIdOrName(parameters[0]);
      const name = site ? getEntityNameFromAddress(site.address) : parameters[0];
      return `${baseName} - ${name}`;
    }
    return baseName;
  },
  description: getI18nValue(
    'RP.XIT.BURNACT.description',
    'Executes a resupply action package for a planet from the burn screen.',
  ),
  component: () => BurnActWindow,
});
