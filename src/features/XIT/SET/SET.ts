import PMMG from '@src/features/XIT/SET/PMMG.vue';
import FINMERGE from '@src/features/XIT/SET/FINMERGE.vue';
import SET from '@src/features/XIT/SET/SET.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: ['SET', 'SETTINGS'],
  name: getI18nValue('RP.XIT.SET.name', 'REFINED PRUN SETTINGS'),
  description: getI18nValue('RP.XIT.SET.description', 'Refined PrUn settings.'),
  optionalParameters: 'Settings Tab Identifier',
  component: parameters => {
    switch (parameters[0]?.toUpperCase()) {
      case 'PMMG':
        return PMMG;
      case 'FINMERGE':
        return FINMERGE;
      default:
        return SET;
    }
  },
});
