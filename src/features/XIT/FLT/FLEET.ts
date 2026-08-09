import FLT from './FLT.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: ['FLT', 'FLEET'],
  name: getI18nValue('RP.XIT.FLT.name', 'FLEET'),
  description: getI18nValue(
    'RP.XIT.FLT.description',
    'Enhanced fleet table with detailed status, cargo, fuel, and quick actions.',
  ),
  component: () => FLT,
});
