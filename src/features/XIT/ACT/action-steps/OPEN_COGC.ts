import { act } from '@src/features/XIT/ACT/act-registry';
import { cogcsStore } from '@src/infrastructure/prun-api/data/cogcs';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { sleep } from '@src/utils/sleep';

interface Data {
  planet: string;
}

export const OPEN_COGC = act.addActionStep<Data>({
  type: 'OPEN_COGC',
  description: data => `Open COGC ${data.planet} for upkeep data`,
  execute: async ctx => {
    const { data, log, requestTile, complete } = ctx;
    const tile = await requestTile(`COGC ${data.planet}`);
    if (!tile) {
      return;
    }

    const naturalId = planetsStore.find(data.planet)?.naturalId ?? data.planet;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (cogcsStore.getByPlanetNaturalId(naturalId) !== undefined) {
        complete();
        return;
      }
      await sleep(200);
    }
    // Some planets have no COGC; treat missing data as success so the run continues.
    log.warning(`No COGC data for ${data.planet} (no COGC on this planet?)`);
    complete();
  },
});
