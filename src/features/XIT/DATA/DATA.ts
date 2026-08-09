import DATA from '@src/features/XIT/DATA/DATA.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'DATA',
  name: getI18nValue('RP.XIT.DATA.name', 'DATA EXPLORER'),
  description: getI18nValue(
    'RP.XIT.DATA.description',
    'Inspect, filter, sort, and download PrUn live data and FIO fallback references without leaving the dashboard.',
  ),
  optionalParameters: 'Source ID, Loopback Endpoint, JSON',
  component: () => DATA,
  bufferSize: [1080, 720],
});
