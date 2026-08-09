import PLANETS from '@src/features/XIT/PLANETS/PLANETS.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: ['PLANETS', 'PLNT'],
  name: getI18nValue('RP.XIT.PLANETS.name', 'BASE PLANETS'),
  description: getI18nValue(
    'RP.XIT.PLANETS.description',
    'Per-planet overrides (resupply days, repair threshold, repair offset) for bases you own.',
  ),
  component: () => PLANETS,
  bufferSize: [700, 400],
});
