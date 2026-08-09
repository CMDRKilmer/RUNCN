import STO from '@src/features/XIT/STO/STO.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: ['STO', 'STORAGE'],
  name: parameters => {
    const baseName = getI18nValue('RP.XIT.STO.name', 'Storage Analysis');
    if (parameters[0]) {
      const site = sitesStore.getByPlanetNaturalIdOrName(parameters[0]);
      if (site) {
        return `${baseName} — ${getEntityNameFromAddress(site.address)}`;
      }
    }
    return baseName;
  },
  description: getI18nValue(
    'RP.XIT.STO.description',
    'Per-base storage analysis: current fill %, days-until-full at current production rate, and ship visitation frequency derived from your fleet.',
  ),
  optionalParameters: 'PLANET',
  component: () => STO,
  bufferSize: [900, 500],
});
