import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/refuel/Edit.vue';
import Configure from '@src/features/XIT/ACT/actions/refuel/Configure.vue';
import { Config } from '@src/features/XIT/ACT/actions/refuel/config';
import { CXPO_BUY } from '@src/features/XIT/ACT/action-steps/CXPO_BUY';
import { MTRA_TRANSFER } from '@src/features/XIT/ACT/action-steps/MTRA_TRANSFER';
import { AssertFn, configurableValue } from '@src/features/XIT/ACT/shared-types';
import { atSameLocation, deserializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { clamp } from '@src/utils/clamp';
import { sumBy } from '@src/utils/sum-by';

interface FuelTypeConfig {
  storageType: string;
  materialTicker: string;
  warningMessage: string;
}

const FUEL_TYPES: FuelTypeConfig[] = [
  {
    storageType: 'STL_FUEL_STORE',
    materialTicker: 'SF',
    warningMessage: 'Not enough SF at the origin. Some ships will not be refueled.',
  },
  {
    storageType: 'FTL_FUEL_STORE',
    materialTicker: 'FF',
    warningMessage: 'Not enough FF at the origin. Some ships will not be refueled.',
  },
];

act.addAction<Config>({
  type: 'Refuel',
  description: action => {
    return action.origin ? 'Refuel all ships near ' + action.origin : '--';
  },
  editComponent: Edit,
  configureComponent: Configure,
  needsConfigure: data => {
    return data.origin === configurableValue;
  },
  isValidConfig: (data, config) => {
    return data.origin !== configurableValue || config.origin !== undefined;
  },
  generateSteps: async ctx => {
    const { data, config, log } = ctx;
    const assert: AssertFn = ctx.assert;

    const serializedOrigin = data.origin === configurableValue ? config?.origin : data.origin;
    const origin = deserializeStorage(serializedOrigin);
    assert(origin, 'Invalid origin');

    const exchangeCode = getExchangeCode(origin);
    const isCX = exchangeCode !== undefined;

    const hasDockedShips = FUEL_TYPES.some(fuelType => {
      const dockedStores =
        storagesStore.getByType(fuelType.storageType)?.filter(x => atSameLocation(x, origin)) ?? [];
      return dockedStores.length > 0;
    });

    if (!hasDockedShips) {
      log.warning('No ships are docked near the origin');
      return;
    }

    let totalRefuel = 0;
    for (const fuelConfig of FUEL_TYPES) {
      const { totalRefuel: fuelRefuel } = processFuelType(
        ctx,
        origin,
        fuelConfig,
        isCX,
        data.buyMissingFuel,
        exchangeCode,
      );
      totalRefuel += fuelRefuel;
    }

    if (totalRefuel === 0) {
      log.info('No ships need refueling');
      return;
    }
  },
});

function processFuelType(
  ctx: ActionContext,
  origin: PrunApi.Store,
  fuelConfig: FuelTypeConfig,
  isCX: boolean,
  buyMissingFuel: boolean | undefined,
  exchangeCode?: string,
): { totalRefuel: number } {
  const { log, emitStep } = ctx;
  const assert: AssertFn = ctx.assert;

  const dockedStores =
    storagesStore.getByType(fuelConfig.storageType)?.filter(x => atSameLocation(x, origin)) ?? [];

  if (dockedStores.length === 0) {
    return { totalRefuel: 0 };
  }

  const material = materialsStore.getByTicker(fuelConfig.materialTicker);
  assert(material, `${fuelConfig.materialTicker} material not found`);

  const totalRefuel = sumBy(dockedStores, x => calculateRefuelAmount(x, material));

  if (totalRefuel === 0) {
    return { totalRefuel };
  }

  let presentFuel =
    origin.items.find(x => x.quantity?.material.ticker === material.ticker)?.quantity?.amount ?? 0;

  if (presentFuel < totalRefuel) {
    if (isCX && buyMissingFuel && exchangeCode) {
      emitStep(
        CXPO_BUY({
          exchange: exchangeCode,
          ticker: material.ticker,
          amount: totalRefuel - presentFuel,
          priceLimit: Number.POSITIVE_INFINITY,
          buyPartial: false,
          allowUnfilled: false,
        }),
      );
      presentFuel = totalRefuel;
    } else {
      log.warning(fuelConfig.warningMessage);
    }
  }

  for (const store of dockedStores) {
    const amount = clamp(calculateRefuelAmount(store, material), 0, presentFuel);
    if (amount === 0) {
      continue;
    }
    emitStep(
      MTRA_TRANSFER({
        from: origin.id,
        to: store.id,
        ticker: material.ticker,
        amount,
      }),
    );
    presentFuel -= amount;
  }

  return { totalRefuel };
}

function getExchangeCode(store: PrunApi.Store) {
  const warehouse = warehousesStore.getById(store.addressableId);
  const originNaturalId = getEntityNaturalIdFromAddress(warehouse?.address);
  const exchange = exchangesStore.getByNaturalId(originNaturalId);
  return exchange?.code;
}

function calculateRefuelAmount(store: PrunApi.Store, material: PrunApi.Material) {
  const freeVolume = store.volumeCapacity - store.volumeLoad;
  return Math.round(freeVolume / material.volume);
}
