import Agent from './Agent.vue';
import ExecuteStoredPackage from './ExecuteStoredPackage.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

xit.add({
  command: 'AGENT',
  name: getI18nValue('RP.XIT.AGENT.name', 'Agent'),
  description: getI18nValue(
    'RP.XIT.AGENT.description',
    'Lists action packages synced via the private refined-agent channel.',
  ),
  optionalParameters: 'Message ID',
  component: params => (params.length > 0 ? ExecuteStoredPackage : Agent),
});
