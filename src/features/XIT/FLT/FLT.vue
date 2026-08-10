<script setup lang="ts">
import { computed } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { isSameAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getInvStore } from '@src/core/store-id';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { useTileState } from '@src/store/user-data-tiles';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import StatusCell from './StatusCell.vue';
import TimeCell from './TimeCell.vue';
import FleetCargoBar from './FleetCargoBar.vue';
import FleetRefuelHeader from './FleetRefuelHeader.vue';
import { fixed0 } from '@src/utils/format';
import coloredValue from '@src/infrastructure/prun-ui/css/colored-value.module.css';

type SortKey =
  'name' | 'cargo' | 'status' | 'eta' | 'fuel' | 'none' | 'repair' | 'size' | 'shipClass';
type SortDirection = 'asc' | 'desc' | 'none';
type FuelAlertThreshold = '75' | '50' | '35' | '25' | '10';
type FuelAlertFilter = 'any' | FuelAlertThreshold;

type FlightRow = {
  ship: PrunApi.Ship;
  stlFuelRatio: number | undefined;
  ftlFuelRatio: number | undefined;
  cargoCapacity: number;
  cargoRatio: number;
  fuelRatio: number;
  warningFuelRatio: number;
  statusSortValue: number;
  conditionText: string;
  conditionClass: string;
  cargoSizeText: string;
  isFtlCapable: boolean;
  inFlight: boolean;
  isReturningToCx: boolean;
  shipClass: string;
  conditionBand: string;
  etaBucket: string;
  cargoState: string;
};

type MultiOptionFilterGroup = {
  key: string;
  title: string;
  options: string[];
  selected: string[];
  onToggle: (option: string) => void;
};

const DEFAULT_SORT_DIRECTION_BY_KEY: Record<SortKey, SortDirection> = {
  name: 'none',
  cargo: 'none',
  status: 'none',
  eta: 'asc',
  fuel: 'none',
  none: 'none',
  repair: 'none',
  size: 'none',
  shipClass: 'asc',
};

const DEFAULTS = {
  primarySortKey: 'shipClass' as SortKey,
  secondarySortKey: 'eta' as SortKey,
  showStlShips: true,
  showFtlShips: true,
  showInFlightShips: true,
  showNotInFlightShips: true,
  hideReturningToCx: false,
  fuelAlertFilter: 'any' as FuelAlertFilter,
  layoutMode: 'compact' as LayoutMode,
  showColName: false,
  showColShipClass: true,
  showColSize: false,
  showColCargo: true,
  showColCargoSize: false,
  showColTime: true,
  showColRepair: false,
  showColFuel: false,
  showColProblems: true,
  problemFuelThreshold: '50' as FuelAlertFilter,
};

const primarySortKey = useTileState<SortKey>('primarySortKey', DEFAULTS.primarySortKey);
const secondarySortKey = useTileState<SortKey>('secondarySortKey', DEFAULTS.secondarySortKey);
const sortDirectionByKey = useTileState<Record<SortKey, SortDirection>>(
  'sortDirectionByKey',
  DEFAULT_SORT_DIRECTION_BY_KEY,
);
const showFilters = useTileState('showFilters', false);
const showStlShips = useTileState('showStlShips', DEFAULTS.showStlShips);
const showFtlShips = useTileState('showFtlShips', DEFAULTS.showFtlShips);
const showInFlightShips = useTileState('showInFlightShips', DEFAULTS.showInFlightShips);
const showNotInFlightShips = useTileState('showNotInFlightShips', DEFAULTS.showNotInFlightShips);
const hideReturningToCx = useTileState('hideReturningToCx', DEFAULTS.hideReturningToCx);
const inventorySizeFilters = useTileState<string[]>('inventorySizeFilters', []);
const shipClassFilters = useTileState<string[]>('shipClassFilters', []);
const conditionFilters = useTileState<string[]>('conditionFilters', []);
const cargoStateFilters = useTileState<string[]>('cargoStateFilters', []);
const etaFilters = useTileState<string[]>('etaFilters', []);
type LayoutMode = 'compact' | 'whitespace' | 'cargo' | 'legacy';

const $style = useCssModule();

const fuelAlertFilter = useTileState<FuelAlertFilter>('fuelAlertFilter', DEFAULTS.fuelAlertFilter);
const layoutMode = useTileState<LayoutMode>('layoutMode', DEFAULTS.layoutMode);

const showColName = useTileState('showColName', DEFAULTS.showColName);
const showColShipClass = useTileState('showColShipClass', DEFAULTS.showColShipClass);
const showColSize = useTileState('showColSize', DEFAULTS.showColSize);
const showColCargo = useTileState('showColCargo', DEFAULTS.showColCargo);
const showColCargoSize = useTileState('showColCargoSize', DEFAULTS.showColCargoSize);
const showColTime = useTileState('showColTime', DEFAULTS.showColTime);
const showColRepair = useTileState('showColRepair', DEFAULTS.showColRepair);
const showColFuel = useTileState('showColFuel', DEFAULTS.showColFuel);
const showColProblems = useTileState('showColProblems', DEFAULTS.showColProblems);
const problemFuelThreshold = useTileState<FuelAlertFilter>(
  'problemFuelThreshold',
  DEFAULTS.problemFuelThreshold,
);

const conditionOptions = ['≥90%', '80-90%', '<80%'];
const etaOptions = ['已对接', '<1小时', '1-6小时', '6-12小时', '12-24小时', '>24小时'];
const cargoStateOptions = ['空载', '部分装载', '满载'];
const fuelAlertOptions: FuelAlertThreshold[] = ['75', '50', '35', '25', '10'];
const fuelAlertThresholdMap: Record<FuelAlertFilter, number> = {
  any: 1,
  '75': 0.75,
  '50': 0.5,
  '35': 0.35,
  '25': 0.25,
  '10': 0.1,
};

const SORT_KEY_LABEL: Record<SortKey, string> = {
  none: '无',
  name: '舰名',
  shipClass: '等级',
  cargo: '货物',
  status: '状态',
  eta: 'ETA',
  repair: '维修',
  size: '容量',
  fuel: '燃料',
};

function sortKeyLabel(key: SortKey) {
  return SORT_KEY_LABEL[key];
}

const rawRows = computed<FlightRow[] | undefined>(() => {
  const ships = shipsStore.all.value;
  if (!ships) {
    return undefined;
  }

  return ships.map(ship => {
    const flight = flightsStore.getById(ship.flightId);
    const inventory = getInvStore(ship.idShipStore);
    const stlStore = storagesStore.getById(ship.idStlFuelStore);
    const ftlStore = storagesStore.getById(ship.idFtlFuelStore);
    const stlFuelRatio = getFuelRatio(stlStore);
    const ftlFuelRatio = getFuelRatio(ftlStore);

    const conditionPercentage = ship.condition * 100;
    const cargoCapacity = inventory
      ? Math.max(inventory.weightCapacity, inventory.volumeCapacity)
      : 0;
    const cargoRatio = inventory
      ? Math.max(
          inventory.weightCapacity > 0 ? inventory.weightLoad / inventory.weightCapacity : 0,
          inventory.volumeCapacity > 0 ? inventory.volumeLoad / inventory.volumeCapacity : 0,
        )
      : 0;
    const fuelRatio = Math.max(stlFuelRatio ?? 0, ftlFuelRatio ?? 0);
    const now = Date.now();
    const arrivalTimestamp = flight?.arrival.timestamp;
    const statusSortValue =
      arrivalTimestamp != null && !Number.isNaN(arrivalTimestamp)
        ? Math.max(0, arrivalTimestamp - now)
        : 0;
    const isFtlCapable = (ftlStore?.weightCapacity ?? 0) > 0;
    const warningFuelRatio = isFtlCapable
      ? Math.min(stlFuelRatio ?? 0, ftlFuelRatio ?? 0)
      : (stlFuelRatio ?? 0);
    const inFlight = ship.flightId != null;
    const isReturningToCx = !!(
      inFlight &&
      flight?.destination &&
      (exchangesStore.all.value ?? []).some(ex => isSameAddress(ex.address, flight.destination))
    );
    const shipClass = getShipClass(ship);
    const conditionBand = getConditionBand(conditionPercentage);
    const etaBucket = getEtaBucket(inFlight, statusSortValue);
    const cargoState = getCargoState(cargoRatio);

    return {
      ship,
      stlFuelRatio,
      ftlFuelRatio,
      cargoCapacity,
      cargoRatio,
      fuelRatio,
      warningFuelRatio,
      statusSortValue,
      conditionText: `${Math.round(conditionPercentage)}%`,
      conditionClass: getConditionClass(conditionPercentage),
      cargoSizeText: getCargoSizeText(inventory),
      isFtlCapable,
      inFlight,
      isReturningToCx,
      shipClass,
      conditionBand,
      etaBucket,
      cargoState,
    };
  });
});

const shipClassOptions = computed(() => {
  const source = rawRows.value;
  if (!source) {
    return [];
  }

  return uniqueOptionValues(source, x => x.shipClass);
});

const inventorySizeOptions = computed(() => {
  const source = rawRows.value;
  if (!source) {
    return [];
  }

  return uniqueOptionValues(source, x => x.cargoSizeText);
});

const filteredRows = computed(() => {
  const source = rawRows.value;
  if (!source) {
    return undefined;
  }

  return source.filter(x => {
    if (!showStlShips.value && !x.isFtlCapable) {
      return false;
    }
    if (!showFtlShips.value && x.isFtlCapable) {
      return false;
    }
    if (!showInFlightShips.value && x.inFlight) {
      return false;
    }
    if (!showNotInFlightShips.value && !x.inFlight) {
      return false;
    }
    if (hideReturningToCx.value && x.isReturningToCx) {
      return false;
    }

    if (!isOptionSelected(shipClassFilters.value, x.shipClass)) {
      return false;
    }
    if (!isOptionSelected(conditionFilters.value, x.conditionBand)) {
      return false;
    }
    if (!isOptionSelected(cargoStateFilters.value, x.cargoState)) {
      return false;
    }
    if (!isOptionSelected(etaFilters.value, x.etaBucket)) {
      return false;
    }

    const threshold = fuelAlertThresholdMap[fuelAlertFilter.value];
    if (threshold < 1 && x.warningFuelRatio > threshold) {
      return false;
    }

    const selectedSizes = inventorySizeFilters.value;
    if (!isOptionSelected(selectedSizes, x.cargoSizeText)) {
      return false;
    }

    return true;
  });
});

const rows = computed(() => {
  const source = filteredRows.value;
  if (!source) {
    return undefined;
  }

  const sorted = [...source];

  const primaryKey = primarySortKey.value;
  const primaryDirection = getSortDirection(primaryKey);
  const secondaryKey = secondarySortKey.value;
  const secondaryDirection = getSortDirection(secondaryKey);

  // If primary sort is disabled, use secondary as primary.
  let activePrimaryKey = primaryKey;
  let activePrimaryDirection = primaryDirection;
  let activeSecondaryKey: SortKey | undefined;
  let activeSecondaryDirection: SortDirection = 'asc';

  if (primaryDirection === 'none') {
    if (secondaryDirection !== 'none') {
      activePrimaryKey = secondaryKey;
      activePrimaryDirection = secondaryDirection;
      activeSecondaryKey = undefined;
    } else {
      activePrimaryKey = 'none';
    }
  } else {
    if (secondaryDirection !== 'none' && secondaryKey !== primaryKey) {
      activeSecondaryKey = secondaryKey;
      activeSecondaryDirection = secondaryDirection;
    }
  }

  const primaryDirMultiplier = activePrimaryDirection === 'asc' ? 1 : -1;
  const secondaryDirMultiplier = activeSecondaryDirection === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    const primary = compareByKey(a, b, activePrimaryKey) * primaryDirMultiplier;
    if (primary !== 0) {
      return primary;
    }

    if (activeSecondaryKey) {
      const secondary = compareByKey(a, b, activeSecondaryKey) * secondaryDirMultiplier;
      if (secondary !== 0) {
        return secondary;
      }
    }

    return compareByKey(a, b, 'name');
  });

  return sorted;
});

const activeFilterCount = computed(() => {
  return [
    !showStlShips.value || !showFtlShips.value,
    !showInFlightShips.value || !showNotInFlightShips.value,
    inventorySizeFilters.value.length > 0,
    hideReturningToCx.value,
    shipClassFilters.value.length > 0,
    conditionFilters.value.length > 0,
    cargoStateFilters.value.length > 0,
    etaFilters.value.length > 0,
    fuelAlertFilter.value !== 'any',
  ].filter(Boolean).length;
});

const problemFuelThresholdValue = computed(() => fuelAlertThresholdMap[problemFuelThreshold.value]);

function hasFuelProblem(row: FlightRow): boolean {
  return hasStlFuelProblem(row) || hasFtlFuelProblem(row);
}

function hasStlFuelProblem(row: FlightRow): boolean {
  const threshold = problemFuelThresholdValue.value;
  return threshold < 1 && (row.stlFuelRatio ?? 1) < threshold;
}

function hasFtlFuelProblem(row: FlightRow): boolean {
  const threshold = problemFuelThresholdValue.value;
  return threshold < 1 && (row.ftlFuelRatio ?? 1) < threshold;
}

const hasAnyProblems = computed(() => {
  const source = rows.value;
  if (!source) {
    return false;
  }
  return source.some(x => x.conditionClass === C.ColoredValue.negative || hasFuelProblem(x));
});

const hasDockedFuelProblem = computed(() => {
  const source = rows.value;
  if (!source) {
    return false;
  }
  return source.some(x => !x.inFlight && hasFuelProblem(x));
});

const gridTemplateColumns = computed(() => {
  const cols: string[] = [];
  if (showColName.value) {
    cols.push('auto');
  }
  if (showColShipClass.value) {
    cols.push('auto');
  }
  if (showColSize.value) {
    cols.push('auto');
  }
  if (showColCargo.value) {
    cols.push(layoutMode.value === 'cargo' ? '1fr' : 'auto');
  }
  if (showColCargoSize.value) {
    cols.push(layoutMode.value === 'cargo' ? '1fr' : 'auto');
  }
  // Status is always shown.
  cols.push('auto');
  if (showColTime.value) {
    cols.push(layoutMode.value === 'whitespace' ? '1fr' : 'auto');
  }
  if (showColRepair.value) {
    cols.push('auto');
  }
  if (showColFuel.value) {
    cols.push('auto');
  }
  if (showColProblems.value && hasAnyProblems.value) {
    cols.push('auto');
  }
  return cols.join(' ');
});

// Legacy mode renders real table elements: `display: table` on divs does not
// reproduce the column sizing of an actual table.
const isLegacy = computed(() => layoutMode.value === 'legacy');
const tableTag = computed(() => (isLegacy.value ? 'table' : 'div'));
const rowTag = computed(() => (isLegacy.value ? 'tr' : 'div'));
const headerCellTag = computed(() => (isLegacy.value ? 'th' : 'div'));
const cellTag = computed(() => (isLegacy.value ? 'td' : 'div'));

const layoutClass = computed(() => {
  if (isLegacy.value) {
    return $style.legacyTable;
  }
  return layoutMode.value === 'compact' ? $style.tableContainer : $style.tableContainerFill;
});

const filterSymbol = computed(() => (showFilters.value ? '-' : '+'));

const optionFilterGroups = computed<MultiOptionFilterGroup[]>(() => [
  {
    key: 'ship-class',
    title: '舰船等级',
    options: shipClassOptions.value,
    selected: shipClassFilters.value,
    onToggle: onShipClassClick,
  },
  {
    key: 'eta-bucket',
    title: 'ETA 区间',
    options: etaOptions,
    selected: etaFilters.value,
    onToggle: onEtaClick,
  },
  {
    key: 'inventory-size',
    title: '货仓容量',
    options: inventorySizeOptions.value,
    selected: inventorySizeFilters.value,
    onToggle: onInventorySizeClick,
  },
  {
    key: 'cargo-state',
    title: '装载状态',
    options: cargoStateOptions,
    selected: cargoStateFilters.value,
    onToggle: onCargoStateClick,
  },
  {
    key: 'condition',
    title: '舰船状态',
    options: conditionOptions,
    selected: conditionFilters.value,
    onToggle: onConditionClick,
  },
]);

function setSort(key: SortKey) {
  if (key === 'none') {
    return;
  }
  if (primarySortKey.value === key) {
    const currentDirection = getSortDirection(key);
    let nextDirection: SortDirection;
    if (currentDirection === 'asc') {
      nextDirection = 'desc';
    } else if (currentDirection === 'desc') {
      nextDirection = 'none';
    } else {
      nextDirection = 'asc';
    }
    sortDirectionByKey.value = {
      ...sortDirectionByKey.value,
      [key]: nextDirection,
    };
    return;
  }

  secondarySortKey.value = primarySortKey.value;
  primarySortKey.value = key;
  sortDirectionByKey.value = {
    ...sortDirectionByKey.value,
    [key]: 'asc',
  };
}

function setPrimarySort(key: SortKey) {
  if (key === 'none') {
    primarySortKey.value = 'none';
    return;
  }
  if (primarySortKey.value === key) {
    const currentDirection = getSortDirection(key);
    sortDirectionByKey.value = {
      ...sortDirectionByKey.value,
      [key]: currentDirection === 'asc' ? 'desc' : 'asc',
    };
  } else {
    primarySortKey.value = key;
    sortDirectionByKey.value = {
      ...sortDirectionByKey.value,
      [key]:
        sortDirectionByKey.value[key] === 'none' ? 'asc' : sortDirectionByKey.value[key] || 'asc',
    };
  }
}

function setSecondarySort(key: SortKey) {
  if (key === 'none') {
    secondarySortKey.value = 'none';
    return;
  }
  if (secondarySortKey.value === key) {
    const currentDirection = getSortDirection(key);
    sortDirectionByKey.value = {
      ...sortDirectionByKey.value,
      [key]: currentDirection === 'asc' ? 'desc' : 'asc',
    };
  } else {
    secondarySortKey.value = key;
    sortDirectionByKey.value = {
      ...sortDirectionByKey.value,
      [key]:
        sortDirectionByKey.value[key] === 'none' ? 'asc' : sortDirectionByKey.value[key] || 'asc',
    };
  }
}

function getSortIndicator(key: SortKey) {
  const direction = getSortDirection(key);
  if (direction === 'none') {
    return undefined;
  }

  if (primarySortKey.value === key) {
    return direction === 'asc' ? '▲' : '▼';
  }
  if (secondarySortKey.value === key && primarySortKey.value !== key) {
    return direction === 'asc' ? '▲' : '▼';
  }
  return undefined;
}

function isPrimarySort(key: SortKey) {
  return primarySortKey.value === key && getSortDirection(key) !== 'none';
}

function isSecondarySort(key: SortKey) {
  return (
    secondarySortKey.value === key &&
    primarySortKey.value !== key &&
    getSortDirection(key) !== 'none'
  );
}

function getSortDirection(key: SortKey) {
  return sortDirectionByKey.value[key] ?? 'asc';
}

// Ties must stay at 0 so the caller can fall through to the secondary key. Folding a
// name comparison in here made every key return a non-zero result and the secondary
// sort never ran.
function compareByKey(a: FlightRow, b: FlightRow, key: SortKey) {
  switch (key) {
    case 'none':
      return 0;
    case 'name':
      return (a.ship.name || a.ship.registration).localeCompare(b.ship.name || b.ship.registration);
    case 'cargo':
      return a.cargoRatio - b.cargoRatio;
    case 'status':
    case 'eta':
      return a.statusSortValue - b.statusSortValue;
    case 'repair':
      return a.ship.condition - b.ship.condition;
    case 'size':
      return a.cargoCapacity - b.cargoCapacity;
    case 'shipClass':
      return a.shipClass.localeCompare(b.shipClass);
    case 'fuel':
      return a.fuelRatio - b.fuelRatio;
  }
}

function getCargoSizeText(inventory: PrunApi.Store | undefined) {
  if (!inventory) {
    return '--/--';
  }

  return `${toCompactK(inventory.weightCapacity)}/${toCompactK(inventory.volumeCapacity)}`;
}

function toCompactK(value: number) {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return fixed0(value);
}

function getFuelRatio(store: PrunApi.Store | undefined) {
  const capacity = store?.weightCapacity;
  if (store == null || capacity == null || capacity <= 0) {
    return undefined;
  }

  return store.weightLoad / capacity;
}

function onFuel(registration: string) {
  showBuffer(`SHPF ${registration}`);
}

function onRefuelAllExchanges() {
  showBuffer('XIT REFUELACT');
}

function toggleFilters() {
  showFilters.value = !showFilters.value;
}

function isOptionSelected(selected: string[], option: string) {
  return selected.length === 0 || selected.includes(option);
}

function uniqueOptionValues<T>(source: T[], getValue: (x: T) => string) {
  const seen = new Set<string>();
  const options: string[] = [];

  for (const x of source) {
    const value = getValue(x);
    if (!seen.has(value)) {
      seen.add(value);
      options.push(value);
    }
  }

  return options;
}

function toggleOptionFilter(
  target: WritableComputedRef<string[]>,
  options: string[],
  option: string,
) {
  const selected = target.value;

  if (selected.length === 0) {
    target.value = options.filter(x => x !== option);
    return;
  }

  let next: string[];
  if (selected.includes(option)) {
    next = selected.filter(x => x !== option);
  } else {
    next = [...selected, option];
  }

  if (next.length === 0 || next.length === options.length) {
    target.value = [];
    return;
  }

  target.value = next;
}

function onShipClassClick(shipClass: string) {
  toggleOptionFilter(shipClassFilters, shipClassOptions.value, shipClass);
}

function onEtaClick(eta: string) {
  toggleOptionFilter(etaFilters, etaOptions, eta);
}

function onInventorySizeClick(size: string) {
  toggleOptionFilter(inventorySizeFilters, inventorySizeOptions.value, size);
}

function onCargoStateClick(cargoState: string) {
  toggleOptionFilter(cargoStateFilters, cargoStateOptions, cargoState);
}

function onConditionClick(band: string) {
  toggleOptionFilter(conditionFilters, conditionOptions, band);
}

function onFuelAlertToggle(threshold: FuelAlertThreshold, enabled: boolean | undefined) {
  fuelAlertFilter.value = enabled === true ? threshold : 'any';
}

function clearFilters() {
  showStlShips.value = DEFAULTS.showStlShips;
  showFtlShips.value = DEFAULTS.showFtlShips;
  showInFlightShips.value = DEFAULTS.showInFlightShips;
  showNotInFlightShips.value = DEFAULTS.showNotInFlightShips;
  hideReturningToCx.value = DEFAULTS.hideReturningToCx;
  inventorySizeFilters.value = [];
  shipClassFilters.value = [];
  conditionFilters.value = [];
  cargoStateFilters.value = [];
  etaFilters.value = [];
  fuelAlertFilter.value = DEFAULTS.fuelAlertFilter;
  layoutMode.value = DEFAULTS.layoutMode;
  primarySortKey.value = DEFAULTS.primarySortKey;
  secondarySortKey.value = DEFAULTS.secondarySortKey;
  sortDirectionByKey.value = { ...DEFAULT_SORT_DIRECTION_BY_KEY };

  showColName.value = DEFAULTS.showColName;
  showColShipClass.value = DEFAULTS.showColShipClass;
  showColSize.value = DEFAULTS.showColSize;
  showColCargo.value = DEFAULTS.showColCargo;
  showColCargoSize.value = DEFAULTS.showColCargoSize;
  showColTime.value = DEFAULTS.showColTime;
  showColRepair.value = DEFAULTS.showColRepair;
  showColFuel.value = DEFAULTS.showColFuel;
  showColProblems.value = DEFAULTS.showColProblems;
  problemFuelThreshold.value = DEFAULTS.problemFuelThreshold;
}

function getConditionClass(condition: number) {
  if (Math.round(condition) <= 79) {
    return C.ColoredValue.negative;
  }
  if (Math.round(condition) <= 81) {
    return coloredValue.warning;
  }
  return C.ColoredValue.positive;
}

function getShipClass(ship: PrunApi.Ship) {
  const name = ship.name?.toUpperCase() ?? '';
  const nameMatch =
    name.match(/^\[([A-Z0-9]{2,6})]/) ??
    name.match(/^\(([A-Z0-9]{2,6})\)/) ??
    name.match(/^([A-Z0-9]{2,6})(?=[\s\-_])/);
  if (nameMatch) {
    return nameMatch[1];
  }

  const registration = ship.registration.toUpperCase();
  const match = registration.match(/^([A-Z0-9]{2,6})/);
  if (match) {
    return match[1];
  }
  return 'UNK';
}

function getConditionBand(condition: number) {
  if (condition >= 90) {
    return '≥90%';
  }
  if (condition >= 80) {
    return '80-90%';
  }
  return '<80%';
}

function getEtaBucket(inFlight: boolean, statusSortValue: number) {
  if (!inFlight) {
    return '已对接';
  }

  const hour = 3600000;
  if (statusSortValue < hour) {
    return '<1小时';
  }
  if (statusSortValue < 6 * hour) {
    return '1-6小时';
  }
  if (statusSortValue < 12 * hour) {
    return '6-12小时';
  }
  if (statusSortValue < 24 * hour) {
    return '12-24小时';
  }
  return '>24小时';
}

function getCargoState(cargoRatio: number) {
  if (cargoRatio <= 0.0001) {
    return '空载';
  }
  if (cargoRatio > 0.95) {
    return '满载';
  }
  return '部分装载';
}
</script>

<template>
  <LoadingSpinner v-if="!rows" />
  <div v-else :class="$style.content">
    <div :class="[C.FormComponent.containerPassive, C.forms.passive, C.forms.formComponent]">
      <label :class="[C.FormComponent.label, C.fonts.fontRegular, C.type.typeRegular]">
        收起
      </label>
      <div :class="[C.FormComponent.input, C.forms.input]">
        <div>
          <div :class="$style.minimize" @click="toggleFilters">{{ filterSymbol }}</div>
        </div>
      </div>
    </div>

    <div v-if="showFilters" :class="$style.filterPanel">
      <div :class="$style.filterMeta">
        <span v-if="activeFilterCount > 0" :class="$style.activeCount">
          {{ activeFilterCount }} 个已启用
        </span>
        <span
          v-if="activeFilterCount > 0"
          :class="[C.Link.link, $style.clearFilters]"
          @click="clearFilters">
          重置
        </span>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">舰船类型</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem v-model="showStlShips" horizontal>亚光速 (STL)</RadioItem>
          <RadioItem v-model="showFtlShips" horizontal>超光速 (FTL)</RadioItem>
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">航行状态</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem v-model="showInFlightShips" horizontal>航行中</RadioItem>
          <RadioItem v-model="showNotInFlightShips" horizontal>已对接</RadioItem>
        </div>
      </div>

      <div v-for="group in optionFilterGroups" :key="group.key" :class="$style.filterGroup">
        <div :class="$style.filterTitle">{{ group.title }}</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem
            v-for="option in group.options"
            :key="`${group.key}-${option}`"
            :model-value="isOptionSelected(group.selected, option)"
            horizontal
            @update:model-value="group.onToggle(option)">
            {{ option }}
          </RadioItem>
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">显示列</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem v-model="showColName" horizontal>舰名</RadioItem>
          <RadioItem v-model="showColShipClass" horizontal>等级</RadioItem>
          <RadioItem v-model="showColSize" horizontal>容量</RadioItem>
          <RadioItem v-model="showColCargo" horizontal>货物</RadioItem>
          <RadioItem v-model="showColCargoSize" horizontal>货物/容量</RadioItem>
          <RadioItem v-model="showColTime" horizontal>ETA</RadioItem>
          <RadioItem v-model="showColRepair" horizontal>维修</RadioItem>
          <RadioItem v-model="showColFuel" horizontal>燃料</RadioItem>
          <RadioItem v-model="showColProblems" horizontal>问题</RadioItem>
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">重置</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem :model-value="false" horizontal @update:model-value="clearFilters"
            >重置所有筛选</RadioItem
          >
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">主排序</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem
            v-for="key in [
              'none',
              'name',
              'shipClass',
              'cargo',
              'status',
              'eta',
              'repair',
              'size',
              'fuel',
            ]"
            :key="`pri-${key}`"
            :model-value="primarySortKey === key"
            horizontal
            @update:model-value="setPrimarySort(key as SortKey)">
            {{ sortKeyLabel(key as SortKey) }}
            {{ primarySortKey === key && key !== 'none' ? getSortIndicator(key as SortKey) : '' }}
          </RadioItem>
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">副排序</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem
            v-for="key in [
              'none',
              'name',
              'shipClass',
              'cargo',
              'status',
              'eta',
              'repair',
              'size',
              'fuel',
            ]"
            :key="`sec-${key}`"
            :model-value="secondarySortKey === key"
            horizontal
            @update:model-value="setSecondarySort(key as SortKey)">
            {{ sortKeyLabel(key as SortKey) }}
            {{ secondarySortKey === key && key !== 'none' ? getSortIndicator(key as SortKey) : '' }}
          </RadioItem>
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">布局</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem
            :model-value="layoutMode === 'compact'"
            horizontal
            @update:model-value="layoutMode = 'compact'"
            >紧凑</RadioItem
          >
          <RadioItem
            :model-value="layoutMode === 'whitespace'"
            horizontal
            @update:model-value="layoutMode = 'whitespace'"
            >宽松</RadioItem
          >
          <RadioItem
            :model-value="layoutMode === 'cargo'"
            horizontal
            @update:model-value="layoutMode = 'cargo'"
            >货物</RadioItem
          >
          <RadioItem
            :model-value="layoutMode === 'legacy'"
            horizontal
            @update:model-value="layoutMode = 'legacy'"
            >经典</RadioItem
          >
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">航线</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem v-model="hideReturningToCx" horizontal>隐藏回 CX 的航行</RadioItem>
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">燃料预警</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem
            v-for="threshold in fuelAlertOptions"
            :key="threshold"
            :model-value="fuelAlertFilter === threshold"
            horizontal
            @update:model-value="onFuelAlertToggle(threshold, $event)">
            ≤{{ threshold }}%
          </RadioItem>
        </div>
      </div>

      <div :class="$style.filterGroup">
        <div :class="$style.filterTitle">问题燃料阈值</div>
        <div :class="C.ComExOrdersPanel.filter">
          <RadioItem
            v-for="threshold in fuelAlertOptions"
            :key="`prob-${threshold}`"
            :model-value="problemFuelThreshold === threshold"
            horizontal
            @update:model-value="problemFuelThreshold = $event ? threshold : 'any'">
            ≤{{ threshold }}%
          </RadioItem>
        </div>
      </div>
    </div>

    <component :is="tableTag" :class="layoutClass" :style="{ gridTemplateColumns }">
      <!-- Header row -->
      <component :is="rowTag" :class="$style.headerRow">
        <component
          :is="headerCellTag"
          v-if="showColName"
          :class="[$style.headerCell, $style.sortable]"
          @click="setSort('name')">
          舰名
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('name'),
              [$style.sortSecondary]: isSecondarySort('name'),
            }">
            {{ getSortIndicator('name') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColShipClass"
          :class="[$style.headerCell, $style.sortable, $style.colShipClass]"
          @click="setSort('shipClass')">
          等级
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('shipClass'),
              [$style.sortSecondary]: isSecondarySort('shipClass'),
            }">
            {{ getSortIndicator('shipClass') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColSize"
          :class="[$style.headerCell, $style.sortable, $style.colSize]"
          @click="setSort('size')">
          容量
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('size'),
              [$style.sortSecondary]: isSecondarySort('size'),
            }">
            {{ getSortIndicator('size') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColCargo"
          :class="[$style.headerCell, $style.sortable]"
          @click="setSort('cargo')">
          货物
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('cargo'),
              [$style.sortSecondary]: isSecondarySort('cargo'),
            }">
            {{ getSortIndicator('cargo') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColCargoSize"
          :class="[$style.headerCell, $style.sortable]"
          @click="setSort('cargo')">
          货物/容量
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('cargo'),
              [$style.sortSecondary]: isSecondarySort('cargo'),
            }">
            {{ getSortIndicator('cargo') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          :class="[$style.headerCell, $style.sortable, $style.colStatus]"
          @click="setSort('status')">
          状态
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('status'),
              [$style.sortSecondary]: isSecondarySort('status'),
            }">
            {{ getSortIndicator('status') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColTime"
          :class="[$style.headerCell, $style.sortable, $style.colTime]"
          @click="setSort('eta')">
          ETA
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('eta'),
              [$style.sortSecondary]: isSecondarySort('eta'),
            }">
            {{ getSortIndicator('eta') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColRepair"
          :class="[$style.headerCell, $style.sortable, $style.colRepair]"
          @click="setSort('repair')">
          维修
          <span
            :class="{
              [$style.sortPrimary]: isPrimarySort('repair'),
              [$style.sortSecondary]: isSecondarySort('repair'),
            }">
            {{ getSortIndicator('repair') }}
          </span>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColFuel"
          :class="[$style.headerCell, $style.sortable, $style.colFuel]"
          @click="setSort('fuel')">
          <FleetRefuelHeader :show-button="!isLegacy" @refuel="onRefuelAllExchanges">
            燃料
            <span
              :class="{
                [$style.sortPrimary]: isPrimarySort('fuel'),
                [$style.sortSecondary]: isSecondarySort('fuel'),
              }">
              {{ getSortIndicator('fuel') }}
            </span>
          </FleetRefuelHeader>
        </component>
        <component
          :is="headerCellTag"
          v-if="showColProblems && hasAnyProblems"
          :class="[$style.headerCell, $style.colProblems]">
          <FleetRefuelHeader
            :show-button="!isLegacy && hasDockedFuelProblem"
            @refuel="onRefuelAllExchanges">
            问题
          </FleetRefuelHeader>
        </component>
      </component>

      <!-- Body rows -->
      <component :is="rowTag" v-for="x in rows" :key="x.ship.id" :class="$style.row">
        <component :is="cellTag" v-if="showColName" :class="[$style.bodyCell]">
          <span :class="C.Link.link" @click="showBuffer(`SFC ${x.ship.registration}`)">
            {{ x.ship.name || x.ship.registration }}
          </span>
        </component>

        <component
          :is="cellTag"
          v-if="showColShipClass"
          :class="[$style.bodyCell, $style.colShipClass]">
          <span :class="C.Link.link" @click.stop="showBuffer(`SFC ${x.ship.registration}`)">
            {{ x.shipClass }}
          </span>
        </component>

        <component
          :is="cellTag"
          v-if="showColSize"
          :class="[$style.bodyCell, $style.colSize, C.ShipStore.pointer]"
          @click="showBuffer(`SHPI ${x.ship.registration}`)">
          {{ x.cargoSizeText }}
        </component>

        <component :is="cellTag" v-if="showColCargo" :class="[$style.bodyCell, $style.cargoCell]">
          <FleetCargoBar :ship-id="x.ship.id" tall />
        </component>

        <component
          :is="cellTag"
          v-if="showColCargoSize"
          :class="[$style.bodyCell, $style.cargoCombinedCell]">
          <FleetCargoBar :ship-id="x.ship.id" />
          <div
            :class="[C.ShipStore.pointer, C.ShipStore.store, $style.cargoCombinedSize]"
            @click="showBuffer(`SHPI ${x.ship.registration}`)">
            {{ x.cargoSizeText }}
          </div>
        </component>

        <component :is="cellTag" :class="[$style.bodyCell, $style.colStatus]">
          <StatusCell :ship-id="x.ship.id" />
        </component>

        <component :is="cellTag" v-if="showColTime" :class="[$style.bodyCell, $style.colTime]">
          <TimeCell :ship-id="x.ship.id" />
        </component>

        <component :is="cellTag" v-if="showColRepair" :class="[$style.bodyCell, $style.colRepair]">
          <span :class="x.conditionClass">{{ x.conditionText }}</span>
        </component>

        <component :is="cellTag" v-if="showColFuel" :class="[$style.bodyCell, $style.colFuel]">
          <div
            :class="[C.ShipFuel.container, C.ShipFuel.pointer, $style.fuelBars]"
            @click="onFuel(x.ship.registration)">
            <div :class="C.ProgressBar.container">
              <progress
                :class="[C.ProgressBar.primary, C.ProgressBar.progress]"
                :value="x.stlFuelRatio ?? 0"
                max="1" />
            </div>
            <div :class="C.ProgressBar.container">
              <progress
                :class="[
                  C.ProgressBar.secondary,
                  C.ProgressBar.progress,
                  !x.isFtlCapable ? C.ProgressBar.warning : undefined,
                ]"
                :value="x.ftlFuelRatio ?? 0"
                max="1" />
            </div>
          </div>
        </component>

        <component
          :is="cellTag"
          v-if="showColProblems && hasAnyProblems"
          :class="[$style.bodyCell, $style.colProblems]">
          <span v-if="x.conditionClass === C.ColoredValue.negative" :class="x.conditionClass">
            {{ x.conditionText }}
          </span>
          <div
            v-if="hasFuelProblem(x)"
            :class="[C.ShipFuel.container, C.ShipFuel.pointer, $style.fuelBars]"
            @click="onFuel(x.ship.registration)">
            <div v-if="hasStlFuelProblem(x)" :class="C.ProgressBar.container">
              <progress
                :class="[C.ProgressBar.primary, C.ProgressBar.progress]"
                :value="x.stlFuelRatio ?? 0"
                max="1" />
            </div>
            <div v-if="hasFtlFuelProblem(x)" :class="C.ProgressBar.container">
              <progress
                :class="[
                  C.ProgressBar.secondary,
                  C.ProgressBar.progress,
                  !x.isFtlCapable ? C.ProgressBar.warning : undefined,
                ]"
                :value="x.ftlFuelRatio ?? 0"
                max="1" />
            </div>
          </div>
        </component>
      </component>
    </component>
  </div>
</template>

<style module>
.content {
  padding-left: 6px;
}

.minimize {
  font-size: 14px;
  font-weight: bold;
  margin-left: auto;
  margin-right: 3px;
  margin-top: 1px;
  text-align: center;
  width: 18px;
  cursor: pointer;
  background-color: #26353e;
  color: #3fa2de;

  &:hover {
    color: #26353e;
    background-color: #3fa2de;
  }
}

.clearFilters {
  user-select: none;
  font-size: 12px;
}

.activeCount {
  display: inline-block;
  border: 1px solid rgb(70, 70, 70);
  border-radius: 3px;
  padding: 1px 6px;
  line-height: 16px;
  color: rgb(174, 184, 195);
}

.filterPanel {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 8px;
}

.filterMeta {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 20px;
}

.filterGroup {
  border: 1px solid rgb(70, 70, 70);
  border-radius: 3px;
  padding: 3px 5px;
  min-width: 0;
  width: fit-content;
}

.filterTitle {
  font-size: 11px;
  text-transform: uppercase;
  opacity: 0.8;
  margin-bottom: 4px;
}

.tableContainer,
.tableContainerFill {
  border-bottom: 1px solid #2b485a;
  container-type: inline-size;
}

/* Grid table structure. */
.tableContainer {
  display: inline-grid;
}

.tableContainerFill {
  display: grid;
  width: 100%;
}

.headerRow {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  border-bottom: 1px solid #2b485a;
  font-weight: normal;
}

.row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  font-size: 11px;
  line-height: 1.1;
  font-family: 'Droid Sans', sans-serif;
}

/* Header and body cell base styles. */
.headerCell,
.bodyCell {
  display: flex;
  align-items: center;
  min-width: 80px;
}

.headerCell {
  padding: 5px 8px 2px;
  font-weight: normal;
}

.bodyCell {
  padding: 4px 6px;
  border-left: 1px solid #2b485a;
}

.bodyCell:first-child {
  border-left: none;
}

.headerCell:first-child {
  border-left: none;
}

.sortable {
  cursor: pointer;
}

.sortPrimary {
  color: rgb(171, 198, 128);
  font-weight: bold;
}

.sortSecondary {
  color: rgb(63, 162, 222);
}

.cargoCell {
  padding: 2px 6px;
}

.cargoCombinedCell {
  flex-direction: column;
  padding: 2px;
  padding-bottom: 0;
}

.cargoCombinedSize {
  margin-top: 2px;
}

.colRepair {
  min-width: 50px;
  justify-content: center;
}

.colShipClass {
  min-width: 40px;
  justify-content: center;
}

.colStatus {
  min-width: 110px;
  border-right: none;
}

/* TimeCell right-aligns its own content, so the header has to follow suit in every
   layout or it drifts to the left edge of the column. */
.colTime {
  border-left: none;
  min-width: 80px;
  justify-content: flex-end;
  text-align: right;
}

.colFuel {
  min-width: 50px;
}

.colProblems {
  min-width: 50px;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.colSize {
  min-width: 50px;
  justify-content: center;
}

.row:nth-child(even) > .bodyCell {
  background-color: rgba(255, 255, 255, 0.02);
}

.row:hover > .bodyCell {
  background-color: rgba(255, 255, 255, 0.06);
}

.fuelBars {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  width: 100%;
}

/* Legacy layout: the container renders as a real table (see tableTag), so the
   auto table algorithm sizes the columns the way the pre-rework FLT table did.
   The display overrides below are still needed because the base .headerCell and
   .bodyCell rules set display: flex. */
.legacyTable {
  width: 100%;
  border-collapse: collapse;
  border-bottom: 1px solid #2b485a;
}

.legacyTable > .headerRow,
.legacyTable > .row {
  display: table-row;
}

.legacyTable .headerCell,
.legacyTable .bodyCell {
  display: table-cell;
  vertical-align: middle;
  min-width: 0;
}

.legacyTable .headerCell {
  padding: 4px 6px;
  text-align: left;
}

.legacyTable .bodyCell {
  padding: 4px 6px;
}

/* Flex alignment no longer applies to table cells, so restore the centered and
   right-aligned columns with text-align. */
.legacyTable .colShipClass,
.legacyTable .colSize,
.legacyTable .colRepair {
  text-align: center;
}

/* Overrides the left-aligned .legacyTable .headerCell rule above. */
.legacyTable .colTime {
  text-align: right;
}

.legacyTable .cargoCell,
.legacyTable .cargoCombinedCell {
  min-width: 70px;
  padding: 2px 2px 0;
}

.legacyTable .colFuel {
  min-width: 120px;
}

.legacyTable .colFuel .fuelBars {
  justify-content: flex-start;
  gap: 2px;
}

.legacyTable .colFuel .fuelBars > div {
  width: 40px;
  flex: 0 0 40px;
}
</style>
