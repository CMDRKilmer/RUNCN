import { act } from '@src/features/XIT/ACT/act-registry';
import { getPlanetName } from '@src/core/planet-name';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

interface Data {
  planet: string;
}

export const OPEN_BRA = act.addActionStep<Data>({
  type: 'OPEN_BRA',
  description: data => {
    const tmpl = getI18nValue('RP.ACT.step.OPEN_BRA.desc', 'Open BRA ${planet} for base repairs');
    return tmpl.replace('${planet}', getPlanetName(data.planet));
  },
  execute: async ctx => {
    const { data, waitAct, requestTile, complete } = ctx;
    const tile = await requestTile(`BRA ${data.planet}`);
    if (!tile) {
      return;
    }
    // Reminder pause: keep ACT grayed so the player runs the repair first.
    const msgTmpl = getI18nValue(
      'RP.ACT.step.OPEN_BRA.wait',
      'Repair buildings at ${planet}, then continue',
    );
    await waitAct(msgTmpl.replace('${planet}', getPlanetName(data.planet)), {
      actDelayMs: 2000,
    });
    complete();
  },
});
