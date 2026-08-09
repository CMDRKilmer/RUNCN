import { act } from '@src/features/XIT/ACT/act-registry';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

interface Data {
  pkg: UserData.ActionPackageData;
}

export const LOG_JSON = act.addActionStep<Data>({
  type: 'LOG_JSON',
  description: data => {
    const tmpl = getI18nValue('RP.ACT.step.LOG_JSON.desc', 'Print [${name}] JSON to the log');
    return tmpl.replace('${name}', data.pkg.global.name);
  },
  execute: async ctx => {
    const { data, complete, log } = ctx;
    const name = data.pkg.global.name ?? 'package';
    log.info(`${name} JSON:`);
    log.label(JSON.stringify(data.pkg, null, 2));
    complete();
  },
});
