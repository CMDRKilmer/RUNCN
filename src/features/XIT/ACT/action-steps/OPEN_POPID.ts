import { act } from '@src/features/XIT/ACT/act-registry';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { populationsStore } from '@src/infrastructure/prun-api/data/populations';
import { populationProjectsStore } from '@src/infrastructure/prun-api/data/population-projects';
import { sleep } from '@src/utils/sleep';

interface Data {
  planet: string;
  ticker: string;
}

export const OPEN_POPID = act.addActionStep<Data>({
  type: 'OPEN_POPID',
  description: data => `Open POPID for ${data.ticker} on ${data.planet}`,
  execute: async ctx => {
    const { data, requestTile, complete, skip, fail } = ctx;

    const popId = planetsStore.find(data.planet)?.populationId;
    const population = populationsStore.getById(popId);
    const infra = population?.infrastructure.find(x => x.ticker === data.ticker);
    if (population === undefined || infra === undefined || infra.level === 0) {
      skip({ silent: true });
      return;
    }

    const tile = await requestTile(`POPID P-${data.planet} T-${data.ticker}`);
    if (!tile) {
      return;
    }

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (populationProjectsStore.getById(infra.projectId) !== undefined) {
        complete();
        return;
      }
      await sleep(200);
    }
    fail(`POPID data for ${data.ticker} on ${data.planet} did not arrive`);
  },
});
