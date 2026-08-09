import INV from './INV.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'INV',
  name: getI18nValue('RP.XIT.INV.name', 'INVENTORIES'),
  description: getI18nValue(
    'RP.XIT.INV.description',
    'Lists all inventories with cargo bars and filters by type.',
  ),
  component: () => INV,
  bufferSize: [620, 400],
});
