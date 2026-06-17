import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/material-groups/resupply/Edit.vue';
import Configure from '@src/features/XIT/ACT/material-groups/resupply/Configure.vue';
import { Config } from '@src/features/XIT/ACT/material-groups/resupply/config';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { calculatePlanetBurn } from '@src/core/burn';
import { watchWhile } from '@src/utils/watch';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';

act.addMaterialGroup<Config>({
  type: 'Resupply',
  description: data => {
    if (!data.planet || data.days === undefined) {
      return '--';
    }

    return `为 ${data.planet} 补给 ${data.days} 天的物资`;
  },
  editComponent: Edit,
  configureComponent: Configure,
  needsConfigure: data => data.planet === configurableValue,
  isValidConfig: (data, config) => data.planet !== configurableValue || config.planet !== undefined,
  generateMaterialBill: async ({ data, config, log, setStatus }) => {
    if (!data.planet) {
      log.error('缺少补给星球');
    }
    if (data.days === undefined) {
      log.error('缺少补给天数');
    }

    const exclusions = data.exclusions ?? [];
    const planet = data.planet === configurableValue ? config.planet : data.planet;
    const site = sitesStore.getByPlanetNaturalIdOrName(planet);
    if (!site) {
      log.error(`${data.planet} 上没有基地`);
    }

    if (!site || data.days === undefined) {
      return undefined;
    }

    const workforce = computed(() => workforcesStore.getById(site?.siteId)?.workforces);
    const production = computed(() => productionStore.getBySiteId(site.siteId));
    if (workforce.value === undefined || production.value === undefined) {
      const name =
        getEntityNameFromAddress(site.address) ?? getEntityNaturalIdFromAddress(site.address);
      setStatus(`Loading ${name} burn data...`);
      await watchWhile(
        toRef(() => workforce.value === undefined || production.value === undefined),
      );
    }
    const stores = storagesStore.getByAddressableId(site.siteId);

    const includeInputs = data.includeInputs !== false && !data.consumablesOnly;

    const planetBurn = calculatePlanetBurn(
      includeInputs ? production.value : undefined,
      workforce.value,
      (data.useBaseInv ?? true) ? stores : undefined,
    );

    const parsedGroup = {};
    for (const ticker of Object.keys(planetBurn)) {
      if (exclusions.includes(ticker)) {
        continue;
      }
      const matBurn = planetBurn[ticker];
      if (matBurn.dailyAmount >= 0) {
        continue;
      }
      if (data.consumablesOnly && matBurn.type !== 'workforce') {
        continue;
      }
      if (
        !data.consumablesOnly &&
        data.includeConsumables === false &&
        matBurn.type === 'workforce'
      ) {
        continue;
      }
      if (!data.consumablesOnly && !includeInputs && matBurn.type === 'input') {
        continue;
      }
      const days = typeof data.days === 'number' ? data.days : parseFloat(data.days);
      const dailyConsume = -matBurn.dailyAmount;
      const inventory = matBurn.inventory;
      if ((data.useBaseInv ?? true) && inventory >= days * dailyConsume) {
        continue;
      }
      const rawRequired = (data.useBaseInv ?? true)
        ? days * dailyConsume - inventory
        : days * dailyConsume;
      const need = Math.floor(Math.max(0, rawRequired));
      if (need > 0) {
        parsedGroup[ticker] = need;
      }
    }
    return parsedGroup;
  },
});
