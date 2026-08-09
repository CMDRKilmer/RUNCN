import NOBUY from '@src/features/XIT/NOBUY/NOBUY.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'NOBUY',
  name: getI18nValue('RP.XIT.NOBUY.name', 'NO BUY LIST'),
  description: getI18nValue(
    'RP.XIT.NOBUY.description',
    'Global list of materials excluded from all ACT material group bills.',
  ),
  component: () => NOBUY,
});
