import getBrowserVersion from '@src/utils/browser-version';
import { userData } from '@src/store/user-data';
import { resolveFeatureGroup } from './feature-groups';

interface FeatureDescriptor {
  id: string;
  description: string;
  advanced?: boolean;
  // 由专门设置项控制的功能：不显示在 XIT SET 功能列表，也不受该列表的禁用状态影响。
  hidden?: boolean;
  init: () => void;
}

const registry: FeatureDescriptor[] = [];

const log = {
  info: console.log,
  http: console.log,
  error: logError,
};

function logError(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  const searchIssueUrl = new URL('https://github.com/refined-prun/refined-prun/issues');
  searchIssueUrl.searchParams.set('q', `is:issue is:open label:bug ${id}`);

  const newIssueUrl = new URL('https://github.com/refined-prun/refined-prun/issues/new');
  newIssueUrl.searchParams.set('template', 'bug_report.yml');
  newIssueUrl.searchParams.set('title', `\`${id}\`: ${message}`);
  newIssueUrl.searchParams.set('version', config.version.toString());
  newIssueUrl.searchParams.set('browser', getBrowserVersion());
  newIssueUrl.searchParams.set(
    'description',
    ['```', String(error instanceof Error ? error.stack! : error).trim(), '```'].join('\n'),
  );

  // 不要改成 'throw Error'，因为 Firefox 不会在控制台显示扩展的错误
  console.group(`❌ Refined PrUn: ${id}`); // Safari supports only one parameter
  console.log(`📕 ${config.version}`, error); // One parameter improves Safari formatting
  console.log('🔍 Search issue', searchIssueUrl.href);
  console.log('🚨 Report issue', newIssueUrl.href);
  console.groupEnd();
}

function add(path: string, init: () => void, description: string, hidden = false) {
  const parts = path.split('/');
  const id = parts.pop()!.split('.')[0];
  let mode = parts.pop()!;
  if (mode === id) {
    mode = parts.pop()!;
  }
  if (import.meta.env.DEV && registry.some(x => x.id === id)) {
    throw Error(`Duplicate feature id: ${id}`);
  }
  // 新增功能若既没命中前缀规则、也没在 feature-groups.ts 的 EXPLICIT 里登记，
  // 就会落进「其他」分组。开发模式下提醒一句，免得玩家比我们先发现。
  if (import.meta.env.DEV) {
    const resolved = resolveFeatureGroup(id);
    if (resolved.source === 'fallback') {
      console.warn(
        `[feature-groups] 「${id}」未命中任何分组规则，已归入「其他」。` +
          '请在 src/features/feature-groups.ts 的 EXPLICIT 里补一行归属。',
      );
    }
  }
  registry.push({
    id,
    description,
    init,
    advanced: mode === 'advanced',
    hidden,
  });
}

function init() {
  const disabledFeatures = new Set(userData.settings.disabled);
  let loaded = 0;
  for (const feature of registry) {
    if (userData.settings.mode !== 'FULL' && feature.advanced) {
      continue;
    }
    if (!feature.hidden && disabledFeatures.has(feature.id)) {
      log.info('↩️', 'Skipping ' + feature.id);
      continue;
    }
    features.current = feature.id;
    try {
      feature.init();
      loaded++;
    } catch (error) {
      log.error(feature.id, error);
    } finally {
      features.current = undefined;
    }
  }
  log.info(`✅ ${loaded} features loaded`);
}

const features = {
  add,
  init,
  current: undefined as string | undefined,
  registry,
};

export default features;
