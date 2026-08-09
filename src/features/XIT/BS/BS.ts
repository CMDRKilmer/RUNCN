import BS from '@src/features/XIT/BS/BS.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'BS',
  name: getI18nValue('RP.XIT.BS.name', 'BASE OVERVIEW'),
  description: getI18nValue(
    'RP.XIT.BS.description',
    'Lists all player bases with links to key base commands.',
  ),
  optionalParameters: 'Planet Identifier(s)',
  component: () => BS,
  bufferSize: [660, 300],
});
