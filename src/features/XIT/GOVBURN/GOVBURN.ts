import GovBurnOverview from '@src/features/XIT/GOVBURN/GovBurnOverview.vue';
import GovBurnPlanetView from '@src/features/XIT/GOVBURN/GovBurnPlanetView.vue';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'GOVBURN',
  name: parameters => {
    const baseName = getI18nValue('RP.XIT.GOVBURN.name', 'GOVERNMENT BURN');
    if (parameters.length === 0) {
      return baseName;
    }
    // Join in case a naturalId/name was split by the XIT router.
    const parameter = parameters.join(' ');
    const planet = planetsStore.find(parameter);
    return `${baseName} - ${planet?.name ?? parameter}`;
  },
  description: getI18nValue(
    'RP.XIT.GOVBURN.description',
    'Tracks planetary infrastructure upkeep.',
  ),
  optionalParameters: 'Planet Identifier',
  component: params => (params.length > 0 ? GovBurnPlanetView : GovBurnOverview),
});
