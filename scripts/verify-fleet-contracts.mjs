// Real FLEET planning, package generation, completion, recovery, sync and native RT record regressions.
// Usage: node --experimental-strip-types scripts/verify-fleet-contracts.mjs.
// Exit 0 = PASS (last line PASS n/n); assertions fail with exit 1.
// Stores, HTTP and windows are fixtures. Hook lifecycle cases defer the estimator; flight models have separate regressions.
// Native RT merge cases drive the real record merge against fixture route payloads; they cover duration invalidation only.
// The fill-inventory cases cover how a ship's fitted days become each base's planned days.
// This does not execute browser actions or contact a server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { effectScope, nextTick, ref } from 'vue';
register('./lib/fleet-loader.mjs', import.meta.url);
const {
  fixture,
  userData,
  sitesStore,
  shipsStore,
  flightsStore,
  transport,
  windows,
  estimation,
  socketMessages,
  dispatchForce,
} = await import('./lib/fleet-stub.mjs');
const { collectChainPlanningSnapshot } = await import('../src/features/XIT/FLEET/chain-data.ts');
const { computeChainPlan } = await import('../src/features/XIT/FLEET/chain-plan-core.ts');
const { useChainPlanning } = await import('../src/features/XIT/FLEET/use-chain-planning.ts');
const { computeLoopPlan } = await import('../src/features/XIT/FLEET/use-chain-loop-planning.ts');
const { fillInventoryDays } = await import('../src/features/XIT/FLEET/supplies-cap.ts');
const { executeChainPlans, clearShipChainPlan } =
  await import('../src/features/XIT/FLEET/chain-commands.ts');
const { planChainRoute } = await import('../src/features/XIT/FLEET/chain-planner.ts');
const { planFastestChainSegments, splitChainPlanAcrossShips } =
  await import('../src/features/XIT/FLEET/chain-allocation.ts');
const { buildChainActionPackages, chainPurchasePackage } =
  await import('../src/features/XIT/FLEET/chain-actions.ts');
const { buildNativeWaypoints, legLoadWeight } =
  await import('../src/features/XIT/FLEET/native-route-plan.ts');
const { completeActionPackage } = await import('../src/features/XIT/FLEET/action-completion.ts');
const { collectPendingChainSteps } = await import('../src/features/XIT/FLEET/chain-recovery.ts');
const { normalizeChainRun } = await import('../src/features/XIT/FLEET/chain-run.ts');
const { createChainSyncController } = await import('../src/features/XIT/FLEET/chain-sync.ts');
const { applyShipDoc } = await import('../src/features/XIT/FLEET/chain-snapshot.ts');
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
const {
  collectNativeRoutes,
  matchRunningRoutes,
  mergeRouteRecord,
  recordsToRemoveAfterDelete,
  routeProgressText,
  routeStopStates,
  withoutRouteDefinition,
} = await import('../src/features/XIT/FLEET/native-route-game.ts');
const { parseRouteStatus } = await import('../src/features/XIT/FLEET/native-route-rte.ts');
const { billShortfall, nativeRouteOriginBill, nativeRoutePurchasePackage, nativeRouteUsableDays } =
  await import('../src/features/XIT/FLEET/native-route-purchase.ts');
const {
  cycleDaysFromHours,
  fuelPerRound,
  roundBill,
  billWeightVolume,
  stockingRoundsMax,
  sustainRounds,
  fullLoadUsableDays,
  netDailyBundle,
  loopSustain,
  loopEligibility,
  actBlockedReason,
} = await import('../src/features/XIT/FLEET/native-route-loop.ts');
const { shipFuelRemainingFor } = await import('../src/features/XIT/FTC/ship-fuel.ts');
const { socketEditStep, socketEditRefuelStep } =
  await import('../src/features/XIT/FLEET/native-route-socket.ts');
let passes = 0;
async function check(name, fn) {
  userData.chainRuns = {};
  userData.actionPackages = [];
  userData.triggers = [];
  Object.assign(fixture, {
    bills: {},
    burns: {},
    products: {},
    supply: {},
    ships: {},
    stores: {},
    production: {},
    analyses: {},
    materials: {},
    stations: {},
    exchanges: {},
    warehouses: {},
  });
  Object.assign(transport, { pushes: [], fetches: 0, remote: null, pending: null, result: null });
  storage.clear();
  windows.length = 0;
  estimation.calls = [];
  estimation.pending = null;
  estimation.result = null;
  shipsStore.fetched.value = true;
  shipsStore.all.value = [];
  sitesStore.all.value = [];
  flightsStore.all.value = [];
  await fn();
  passes++;
  console.log(`PASS ${name}`);
}
const capacity = { weight: 100, volume: 100, freeWeight: 100, freeVolume: 100 };
function bases() {
  return ['A', 'B'].map(id => {
    const site = { siteId: id, address: { id } };
    sitesStore.all.value.push(site);
    fixture.bills[id] = { RAT: 10 };
    fixture.burns[id] = {
      burn: { RAT: { input: 1, output: 0, workforce: 0, inventory: 0, daysLeft: 0 } },
    };
    return { siteId: id, naturalId: id, planetName: id, site, config: { days: 10, cxBuy: true } };
  });
}
const ship = (id, items = []) => ({
  ship: { id, registration: id, name: id, address: { id: 'CX' } },
  exchangeCode: 'AI1',
  warehouseStore: { id: 'warehouse', items },
  cargoStore: {
    id: `cargo-${id}`,
    items: [],
    weightCapacity: 100,
    volumeCapacity: 100,
    weightLoad: 0,
    volumeLoad: 0,
  },
});
await check('native RT keeps warehouse departure and return as separate waypoints', () => {
  const plan = {
    originNaturalId: 'CX',
    cxBill: { RAT: 14 },
    purchaseBill: { RAT: 10 },
    originPickup: { RAT: 4 },
    finalUnload: { FE: 3 },
    stops: [
      {
        naturalId: 'A',
        unloadCx: {},
        unloadChain: new Map(),
        load: new Map([['RAT', { amount: 2 }]]),
      },
      {
        naturalId: 'B',
        unloadCx: { RAT: 14 },
        unloadChain: new Map([['RAT', { amount: 2 }]]),
        load: new Map([['FE', { amount: 3 }]]),
      },
    ],
  };
  assert.deepEqual(buildNativeWaypoints(plan), [
    { location: 'CX', steps: [{ kind: 'load', ticker: 'RAT', amount: 14 }] },
    { location: 'A', steps: [{ kind: 'load', ticker: 'RAT', amount: 2 }] },
    {
      location: 'B',
      steps: [
        { kind: 'unload', ticker: 'RAT', amount: 16 },
        { kind: 'load', ticker: 'FE', amount: 3 },
      ],
    },
    { location: 'CX', steps: [{ kind: 'unload', ticker: 'FE', amount: 3 }] },
  ]);
  assert.deepEqual(buildNativeWaypoints({ ...plan, finalUnload: {} }).at(-1), {
    location: 'CX',
    steps: [],
  });
  assert.throws(() => buildNativeWaypoints({ ...plan, hasUnmetChainDemand: true }));
  const procurement = chainPurchasePackage(ship('S'), plan);
  assert.deepEqual(
    procurement.actions.map(x => x.type),
    ['CX Buy'],
  );
  assert.deepEqual(procurement.actions[0].cxInvReserve, { RAT: 4 });
  assert.deepEqual(procurement.groups[0].materials, { RAT: 10 });
});
await check('native RT legs use the load carried after each stop', () => {
  const plan = {
    loadOnDeparture: { weight: 12 },
    loadOnReturn: { weight: 7 },
    stops: [
      { naturalId: 'A', loadOnDeparture: { weight: 9 } },
      { naturalId: 'B', loadOnDeparture: { weight: 5 } },
    ],
  };
  // 航点 = 出发地 + 2 站 + 归航 ⇒ 3 段：出发装载 / 首站离站 / 归航舱载。
  assert.deepEqual(
    [1, 2, 3].map(index => legLoadWeight(plan, index, 3)),
    [12, 9, 7],
  );
});
await check('market cap changes every downstream bill and cargo snapshot', () => {
  fixture.supply['RAT.AI1'] = 10;
  const plan = planChainRoute({
    originNaturalId: 'CX',
    capacity,
    bases: bases(),
    exchangeCode: 'AI1',
  });
  assert.deepEqual(plan.purchaseBill, { RAT: 10 });
  assert.deepEqual(plan.cxBill, { RAT: 10 });
  assert.equal(
    plan.stops.reduce((n, stop) => n + (stop.unloadCx.RAT ?? 0), 0),
    10,
  );
  assert.equal(plan.loadOnDeparture.weight, 10);
  assert.equal(plan.loadOnReturn.weight, 0);
});
await check('zero supply removes empty stops, unknown supply preserves demand', () => {
  const bs = bases();
  fixture.supply['RAT.AI1'] = 0;
  assert.equal(
    planChainRoute({ originNaturalId: 'CX', capacity, bases: bs, exchangeCode: 'AI1' }).stops
      .length,
    0,
  );
  fixture.supply = {};
  assert.equal(
    planChainRoute({ originNaturalId: 'CX', capacity, bases: bs, exchangeCode: 'AI1' }).cxBill.RAT,
    20,
  );
});
await check('two ships reserve a shared warehouse only once', () => {
  const bs = bases();
  const items = [{ quantity: { material: { ticker: 'RAT' }, amount: 10 } }];
  const ships = [ship('S1', items), ship('S2', items)];
  const plan = planChainRoute({ originNaturalId: 'CX', capacity, bases: bs });
  const plans = splitChainPlanAcrossShips(plan, ships, bs, undefined, [['A'], ['B']]);
  assert.equal(
    plans.reduce((n, p) => n + (p.plan.originPickup.RAT ?? 0), 0),
    10,
  );
  assert.equal(
    plans.reduce((n, p) => n + (p.plan.purchaseBill.RAT ?? 0), 0),
    10,
  );
});
await check('departure package separates planned purchases from reserved warehouse stock', () => {
  const plan = planChainRoute({
    originNaturalId: 'CX',
    capacity,
    bases: bases(),
    originStock: { RAT: 6 },
  });
  const { mainPkg } = buildChainActionPackages(ship('S'), plan);
  const purchase = mainPkg.actions.find(x => x.type === 'CX Buy');
  const load = mainPkg.actions.find(x => x.type === 'MTRA');
  assert.deepEqual(mainPkg.groups.find(x => x.name === purchase.group).materials, { RAT: 14 });
  assert.deepEqual(purchase.cxInvReserve, { RAT: 6 });
  assert.deepEqual(mainPkg.groups.find(x => x.name === load.group).materials, { RAT: 20 });
});
await check('cargo verification retains cargo allocated to the next stop', () => {
  const plan = planChainRoute({ originNaturalId: 'CX', capacity, bases: bases() });
  const built = buildChainActionPackages(ship('S'), plan);
  assert.deepEqual(
    built.stopPkgs[0].pkg.actions.find(x => x.type === 'Verify Ship Cargo').verifyRemaining,
    { RAT: 10 },
  );
  assert.deepEqual(
    built.stopPkgs[1].pkg.actions.find(x => x.type === 'Verify Ship Cargo').verifyRemaining,
    { RAT: 0 },
  );
  plan.stops[0].load.set('RAT', { amount: 5, to: 'CX' });
  assert.deepEqual(
    buildChainActionPackages(ship('S'), plan).stopPkgs[0].pkg.actions.find(
      x => x.type === 'Verify Ship Cargo',
    ).verifyRemaining,
    { RAT: 15 },
  );
});
await check('successful retained package removes one-shot triggers and marks progress', () => {
  const pkg = { global: { name: '1 A Loop S' }, groups: [], actions: [] };
  userData.actionPackages.push(pkg);
  userData.triggers.push(
    { id: 'one', packageName: pkg.global.name, autoDelete: true },
    { id: 'keep', packageName: pkg.global.name },
  );
  userData.chainRuns.S = { stops: [{ pkgName: pkg.global.name, state: 'pending' }] };
  completeActionPackage(pkg);
  assert.equal(userData.chainRuns.S.stops[0].state, 'done');
  assert.equal(userData.actionPackages.length, 1);
  assert.deepEqual(
    userData.triggers.map(x => x.id),
    ['keep'],
  );
});
await check('normalization advances passed stops before recovery selection', () => {
  fixture.ships.S = { address: { id: 'B' } };
  const run = {
    shipId: 'S',
    originNaturalId: 'CX',
    stops: ['A', 'B'].map(id => ({ naturalId: id, pkgName: id, state: 'pending' })),
  };
  userData.actionPackages = ['A', 'B'].map(name => ({ global: { name } }));
  userData.chainRuns.S = run;
  const steps = collectPendingChainSteps(false);
  assert.deepEqual(
    steps.map(x => x.pkgName),
    ['B'],
  );
  normalizeChainRun(run);
  assert.deepEqual(
    run.stops.map(x => x.state),
    ['done', 'arrived'],
  );
});
function syncRun() {
  const name = '0 Chain S 1234567890';
  userData.chainRuns.S = {
    shipId: 'S',
    shipName: 'S',
    fp: '1234567890',
    mainPkgName: name,
    originNaturalId: 'CX',
    stops: [],
    originState: 'pending',
  };
  userData.actionPackages.push({ global: { name }, groups: [], actions: [] });
}
await check('a modification during upload remains dirty for the next batch', async () => {
  syncRun();
  const controller = createChainSyncController({ resolveShipName: () => 'S' });
  controller.start();
  let release;
  transport.pending = new Promise(resolve => {
    release = resolve;
  });
  controller.markDirtyShip('S');
  const upload = controller.pushNow();
  for (let i = 0; i < 100 && transport.pushes.length === 0; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(transport.pushes.length, 1, JSON.stringify(controller.state));
  userData.chainRuns.S.originState = 'done';
  controller.markDirtyShip('S');
  transport.pending = null;
  release();
  await upload;
  assert.equal(controller.state.dirty, true);
  await controller.pushNow();
  controller.stop();
  assert.equal(transport.pushes.length, 2);
  assert.equal(transport.pushes[1].doc.chainRuns.S.originState, 'done');
});
await check('pending updates survive controller restart without a new edit', async () => {
  syncRun();
  const first = createChainSyncController({ resolveShipName: () => 'S' });
  first.start();
  first.markDirtyShip('S');
  first.stop();
  const second = createChainSyncController({ resolveShipName: () => 'S' });
  second.start();
  await second.pushNow();
  second.stop();
  assert.equal(transport.pushes.length, 1);
});
await check(
  'remote replacement applies full trigger settings while retaining local id',
  async () => {
    syncRun();
    const trigger = {
      id: 'local',
      name: 'arrival',
      packageName: userData.chainRuns.S.mainPkgName,
      event: { type: 'FLIGHT_ENDED' },
      mode: 'AUTO',
      enabled: true,
      cooldownMin: 60,
      autoDelete: false,
    };
    userData.triggers.push(trigger);
    const doc = {
      version: 1,
      updatedAt: 1,
      chainRuns: { S: structuredClone(userData.chainRuns.S.__v_raw) },
      actionPackages: [],
      triggers: [{ ...trigger, id: 'remote', enabled: false, cooldownMin: 10, autoDelete: true }],
    };
    applyShipDoc('S', doc, () => 'S');
    await nextTick();
    assert.equal(userData.triggers[0].id, 'local');
    assert.equal(userData.triggers[0].enabled, false);
    assert.equal(userData.triggers[0].cooldownMin, 10);
    assert.equal(userData.triggers[0].autoDelete, true);
  },
);
await check('conflicts stay gated until an explicit force upload', async () => {
  syncRun();
  const controller = createChainSyncController({ resolveShipName: () => 'S' });
  controller.start();
  controller.markDirtyShip('S');
  transport.result = {
    ok: false,
    latest: {
      updatedAt: 2000,
      payload: { version: 1, updatedAt: 100, chainRuns: {}, actionPackages: [], triggers: [] },
    },
  };
  await controller.pushNow();
  assert.equal(controller.state.conflict, true);
  await controller.pushNow();
  assert.equal(transport.pushes.length, 1);
  transport.result = null;
  await controller.pushNow(true, 'S');
  controller.stop();
  assert.equal(transport.pushes.length, 2);
  assert.equal(transport.pushes[1].base, 2000);
  assert.equal(controller.state.conflict, false);
});
await check('a captured plan remains reproducible after live data changes', () => {
  const bs = bases();
  const snapshot = collectChainPlanningSnapshot({
    originNaturalId: 'CX',
    capacity,
    bases: bs,
    originStock: { RAT: 5 },
  });
  const before = structuredClone(snapshot);
  const first = computeChainPlan(snapshot, String);
  fixture.bills.A.RAT = 999;
  fixture.burns.A.burn.RAT.inventory = 999;
  fixture.supply['RAT.AI1'] = 0;
  bs[0].config.days = 999;
  assert.deepEqual(computeChainPlan(snapshot, String), first);
  assert.deepEqual(snapshot, before);
  assert.equal(first.cxBill.RAT, 20);
  assert.equal(first.originPickup.RAT, 5);
});
await check('snapshot projection includes started production and arrival consumption', () => {
  const bs = bases().slice(0, 1);
  bs[0].config.days = 0;
  fixture.bills.A = {};
  fixture.products.A = ['RAW'];
  fixture.burns.A = {
    burn: { RAW: { input: 1, output: 2, workforce: 0, inventory: 3, daysLeft: Infinity } },
  };
  fixture.production.A = [
    {
      capacity: 1,
      orders: [
        {
          started: { timestamp: 1_000_000 },
          completion: { timestamp: 4_600_000 },
          duration: { millis: 3_600_000 },
          halted: false,
          recurring: false,
          inputs: [],
          outputs: [{ material: { ticker: 'RAW' }, amount: 10 }],
        },
      ],
    },
  ];
  const snapshot = collectChainPlanningSnapshot({
    originNaturalId: 'CX',
    capacity,
    bases: bs,
    arrivalHoursByNaturalId: new Map([['A', 1]]),
  });
  assert.equal(snapshot.bases[0].projectedStock.RAW, 13 - 1 / 24);
  assert.equal(computeChainPlan(snapshot, String).finalUnload.RAW, 12);
  assert.equal(fixture.burns.A.burn.RAW.output, 2);
});
await check('snapshot projection schedules recurring copies after the batch ends', () => {
  const bs = bases().slice(0, 1);
  bs[0].config.days = 0;
  fixture.bills.A = {};
  fixture.products.A = ['RAT'];
  fixture.burns.A = {
    burn: { RAT: { input: 0, output: 1, workforce: 0, inventory: 0, daysLeft: Infinity } },
  };
  // 两槽位：非循环订单到 1,010,000 结束；循环订单到 1,020,000 结束。
  // 到港时刻 = 1,030,000（now + 30 s）。循环副本只能从 1,020,000 开始，
  // 若提前占用 1,010,000 释放的槽位，到港产量会从 30 高估成 40。
  fixture.production.A = [
    {
      capacity: 2,
      orders: [
        {
          started: { timestamp: 900_000 },
          completion: { timestamp: 1_010_000 },
          duration: { millis: 110_000 },
          halted: false,
          recurring: false,
          inputs: [],
          outputs: [{ material: { ticker: 'OTH' }, amount: 5 }],
        },
        {
          started: { timestamp: 900_000 },
          completion: { timestamp: 1_020_000 },
          duration: { millis: 120_000 },
          halted: false,
          recurring: true,
          inputs: [],
          outputs: [{ material: { ticker: 'RAT' }, amount: 120 }],
        },
      ],
    },
  ];
  const snapshot = collectChainPlanningSnapshot({
    originNaturalId: 'CX',
    capacity,
    bases: bs,
    // 30 s 后到港。
    arrivalHoursByNaturalId: new Map([['A', 30_000 / 3_600_000]]),
  });
  // 当前批次：120 × 20 s / 120 s = 20；下一份：120 × 10 s / 120 s = 10。
  assert.ok(Math.abs(snapshot.bases[0].projectedStock.RAT - 30) < 1e-9);
});

await check(
  'chain allocation prioritizes the most urgent downstream without mutating input',
  () => {
    const mat = (input, output, inventory, daysLeft) => ({
      input,
      output,
      workforce: 0,
      inventory,
      daysLeft,
    });
    const base = (naturalId, burn, products, bill, projectedStock) => ({
      naturalId,
      planetName: naturalId,
      days: 15,
      cxBuy: true,
      burn,
      products,
      bill,
      projectedStock,
      daysUntilFull: 5,
    });
    const snapshot = {
      originNaturalId: 'CX',
      capacity,
      originStock: {},
      purchaseStock: {},
      planetRanks: { A: 0, B: 1, C: 2 },
      materials: { RAW: { weight: 1, volume: 1 } },
      consumers: new Map([['RAW', ['B', 'C']]]),
      bases: [
        base('A', { RAW: mat(0, 10, 20, Infinity) }, ['RAW'], {}, { RAW: 20 }),
        base('B', { RAW: mat(1, 0, 0, 5) }, [], { RAW: 15 }, { RAW: 0 }),
        base('C', { RAW: mat(1, 0, 0, 1) }, [], { RAW: 15 }, { RAW: 0 }),
      ],
    };
    const before = structuredClone(snapshot);
    const plan = computeChainPlan(snapshot, String);
    assert.equal(plan.stops.find(x => x.naturalId === 'C').unloadChain.get('RAW').amount, 15);
    assert.equal(plan.stops.find(x => x.naturalId === 'B').unloadChain.get('RAW').amount, 5);
    assert.deepEqual(plan.purchaseBill, {});
    assert.deepEqual(snapshot, before);
  },
);
await check('equal planet ranks keep stable frontier ordering', () => {
  const raw = { input: 0, output: 1, workforce: 0, inventory: 20, daysLeft: Infinity };
  const need = { input: 1, output: 0, workforce: 0, inventory: 0, daysLeft: 0 };
  const base = (id, burn, products, bill) => ({
    naturalId: id,
    planetName: id,
    days: 1,
    cxBuy: true,
    burn,
    products,
    bill,
    projectedStock: Object.fromEntries(
      Object.entries(burn).map(([ticker, mat]) => [ticker, mat.inventory]),
    ),
    daysUntilFull: Infinity,
  });
  const snapshot = {
    originNaturalId: 'CX',
    capacity,
    originStock: {},
    purchaseStock: {},
    planetRanks: { A: 0, B: 0, C: 0 },
    materials: { RAW: { weight: 1, volume: 1 }, RAT: { weight: 1, volume: 1 } },
    consumers: new Map([['RAW', ['B']]]),
    bases: [
      base('B', { RAW: need }, [], { RAW: 1 }),
      base('A', { RAW: raw }, ['RAW'], {}),
      base('C', { RAT: need }, [], { RAT: 1 }),
    ],
  };
  assert.deepEqual(
    computeChainPlan(snapshot, String).stops.map(x => x.naturalId),
    ['A', 'C', 'B'],
  );
});
await check('combined planning retains stops for ships at another exchange', async () => {
  const bs = bases();
  const ships = [ship('S1'), ship('S2')];
  ships[0].cargoStore.weightCapacity = ships[0].cargoStore.volumeCapacity = 10;
  ships[1].cargoStore.weightCapacity = ships[1].cargoStore.volumeCapacity = 10;
  ships[1].exchangeCode = 'NC1';
  fixture.supply['RAT.AI1'] = 0;
  fixture.supply['RAT.NC1'] = 10;
  const scope = effectScope();
  const planning = scope.run(() =>
    useChainPlanning({ ships: () => ships, bases: () => bs, runs: () => [] }),
  );
  assert.equal(planning.basePlan.value.stops.length, 2);
  assert.equal(planning.shipPlans.value.length, 1);
  assert.equal(planning.hasStops.value, true);
  assert.equal(planning.shipPlans.value.find(x => x.ship.ship.id === 'S2').plan.cxBill.RAT, 10);
  scope.stop();
  await nextTick();
});
await check('fastest split reverses ship order and breaks ties on total flight time', () => {
  const cap = { freeWeight: 1, freeVolume: 1 };
  const sizes = [
    { weight: 1, volume: 1 },
    { weight: 1, volume: 1 },
  ];
  const allocation = planFastestChainSegments({
    capacities: [cap, cap],
    stopSizes: sizes,
    timings: [
      { outbound: [8, 3], inbound: [2, 7], between: [undefined] },
      { outbound: [0.5, 5], inbound: [0.5, 2], between: [undefined] },
    ],
  });
  assert.deepEqual(allocation, {
    ranges: [
      { start: 1, end: 2 },
      { start: 0, end: 1 },
    ],
    hours: [10, 1],
  });
  const missing = planFastestChainSegments({
    capacities: [cap, cap],
    stopSizes: sizes,
    timings: [
      { outbound: [undefined, 3], inbound: [2, 7], between: [undefined] },
      { outbound: [0.5, undefined], inbound: [0.5, 2], between: [undefined] },
    ],
  });
  assert.deepEqual(missing, allocation);
  const oversized = planFastestChainSegments({
    capacities: [cap, cap],
    stopSizes: [sizes[0], { weight: 1, volume: 2 }],
    timings: [
      { outbound: [8, 3], inbound: [2, 7], between: [1] },
      { outbound: [0.5, 5], inbound: [0.5, 2], between: [1] },
    ],
  });
  assert.equal(oversized, undefined);
});
await check(
  'ring planning uses each origin and applies the faster order with partial estimates',
  async () => {
    const bs = bases();
    const items = [{ quantity: { material: { ticker: 'RAT' }, amount: 10 } }];
    const ships = [ship('S1', items), ship('S2', items)];
    for (const vessel of ships) {
      vessel.cargoStore.weightCapacity = vessel.cargoStore.volumeCapacity = 10;
      vessel.ship.address.id = `CX-${vessel.ship.id}`;
    }
    estimation.result = input => ({
      ok: false,
      legs: [
        { ok: true, hours: 5 },
        { ok: false, hours: 0 },
        { ok: true, hours: 5 },
      ],
      endpointHours: input.includeEndpointHours
        ? input.ship.id === 'S1'
          ? { outbound: [5, 1], inbound: [5, 1] }
          : { outbound: [1, 5], inbound: [1, 5] }
        : undefined,
    });
    const scope = effectScope();
    try {
      const planning = scope.run(() =>
        useChainPlanning({ ships: () => ships, bases: () => bs, runs: () => [] }),
      );
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(
        estimation.calls.filter(call => call.includeEndpointHours).map(call => call.origin),
        ['CX-S1', 'CX-S2'],
      );
      assert.deepEqual(
        planning.shipPlans.value.map(p => [p.ship.ship.id, p.plan.stops[0].naturalId]),
        [
          ['S2', 'A'],
          ['S1', 'B'],
        ],
      );
      assert.equal(planning.shipPlans.value[0].plan.originPickup.RAT, 10);
      assert.equal(planning.shipPlans.value[1].plan.purchaseBill.RAT, 10);
    } finally {
      scope.stop();
      await nextTick();
    }
  },
);
await check(
  'chain selection fits each ship without using dispatch assignments or days',
  async () => {
    const bs = bases();
    for (const base of bs) {
      base.config.resupply = true;
      base.config.days = 2;
      fixture.analyses[base.siteId] = { suppliesCapDays: 40 };
      fixture.bills[base.siteId] = config =>
        config.days > 0 ? { RAT: Math.ceil(Math.min(config.days, 40)) } : {};
    }
    const first = ship('S1');
    first.cargoStore.volumeCapacity = 35;
    first.cargoStore.volumeLoad = 5;
    const second = ship('S2');
    second.cargoStore.weightCapacity = 32;
    second.cargoStore.weightLoad = 2;
    const selected = ref([first]);
    const runs = ref([]);
    const scope = effectScope();
    try {
      const planning = scope.run(() =>
        useChainPlanning({ ships: () => selected.value, bases: () => bs, runs: () => runs.value }),
      );
      const days = () => planning.shipPlans.value.flatMap(p => p.plan.stops.map(stop => stop.days));
      assert.deepEqual(days(), [15, 15]);
      selected.value = [first, second];
      await nextTick();
      assert.deepEqual(days(), [30, 30]);
      assert.ok(planning.shipPlans.value.every(p => !p.plan.overCapacity));
      selected.value = [
        { ...first, cargoStore: { ...first.cargoStore, volumeCapacity: 10 } },
        second,
      ];
      await nextTick();
      assert.deepEqual(days(), [15, 15]);
      assert.deepEqual(
        planning.shipPlans.value.map(p => p.ship.ship.id),
        ['S2'],
      );
      runs.value = [{ shipId: 'S1', run: {} }];
      assert.deepEqual(days(), [15, 15]);
      assert.deepEqual(
        bs.map(base => [base.config.ship, base.config.days]),
        [
          [undefined, 2],
          [undefined, 2],
        ],
      );
    } finally {
      scope.stop();
      await nextTick();
    }
  },
);
await check('capacity fitting can assign complementary ships in reverse order', () => {
  const bs = bases();
  for (const base of bs) {
    base.config.resupply = true;
    fixture.analyses[base.siteId] = { suppliesCapDays: 1 };
    const ticker = base.siteId === 'A' ? 'HEAVY' : 'BULKY';
    fixture.bills[base.siteId] = config => (config.days > 0 ? { [ticker]: 1 } : {});
  }
  fixture.materials.HEAVY = { weight: 2, volume: 1 };
  fixture.materials.BULKY = { weight: 1, volume: 2 };
  const ships = [ship('S1'), ship('S2')];
  Object.assign(ships[0].cargoStore, { weightCapacity: 1, volumeCapacity: 2 });
  Object.assign(ships[1].cargoStore, { weightCapacity: 2, volumeCapacity: 1 });
  const scope = effectScope();
  try {
    const planning = scope.run(() =>
      useChainPlanning({ ships: () => ships, bases: () => bs, runs: () => [] }),
    );
    assert.deepEqual(
      planning.shipPlans.value.map(p => [
        p.ship.ship.id,
        p.plan.stops[0].naturalId,
        p.plan.stops[0].days,
      ]),
      [
        ['S2', 'A', 1],
        ['S1', 'B', 1],
      ],
    );
  } finally {
    scope.stop();
  }
});
await check(
  'capacity fitting lowers targets that exhaust a producer’s transferable stock',
  async () => {
    const bs = bases();
    for (const base of bs) {
      base.config.resupply = true;
      fixture.analyses[base.siteId] = { suppliesCapDays: 40 };
    }
    fixture.products.A = ['RAT'];
    fixture.burns.A.burn.RAT = {
      input: 1,
      output: 2,
      workforce: 0,
      inventory: 10,
      daysLeft: Infinity,
    };
    fixture.bills.A = {};
    fixture.bills.B = config => (config.days > 0 ? { RAT: Math.ceil(config.days) } : {});
    const ships = ref([ship('S1')]);
    estimation.result = input => ({
      ok: input.includeEndpointHours === true,
      legs: [
        { ok: true, hours: 1 },
        { ok: true, hours: 10 },
        { ok: true, hours: 1 },
      ],
      endpointHours: input.includeEndpointHours ? { outbound: [1, 1], inbound: [1, 1] } : undefined,
    });
    const scope = effectScope();
    try {
      const planning = scope.run(() =>
        useChainPlanning({ ships: () => ships.value, bases: () => bs, runs: () => [] }),
      );
      const stops = planning.shipPlans.value.flatMap(p => p.plan.stops);
      const consumer = stops.find(stop => stop.naturalId === 'B');
      assert.equal(consumer?.days, 5);
      assert.equal(consumer?.unloadChain.get('RAT')?.amount, 5);
      ships.value.push(ship('S2'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(planning.allocStatus.value, 'ready');
      assert.equal(planning.shipPlans.value.length, 1);
      assert.equal(planning.shipPlans.value[0].plan.stops[1].unloadChain.get('RAT').amount, 5);
    } finally {
      scope.stop();
    }
  },
);
await check('fitting counts clipped deliveries without rejecting clipped surplus returns', () => {
  const bs = bases();
  for (const base of bs) {
    base.config.resupply = true;
    fixture.analyses[base.siteId] = { suppliesCapDays: 40 };
  }
  fixture.products.A = ['RAT'];
  fixture.burns.A.burn.RAT = { input: 0, output: 2, workforce: 0, inventory: 100 };
  fixture.bills.A = {};
  fixture.bills.B = config => (config.days > 0 ? { RAT: Math.ceil(config.days) } : {});
  const vessel = ship('S');
  Object.assign(vessel.cargoStore, { weightCapacity: 10, volumeCapacity: 10 });
  const scope = effectScope();
  try {
    const planning = scope.run(() =>
      useChainPlanning({ ships: () => [vessel], bases: () => bs, runs: () => [] }),
    );
    const plan = planning.shipPlans.value[0].plan;
    assert.equal(plan.stops[0].clipped, true);
    assert.equal(plan.hasUnmetChainDemand, undefined);
    assert.equal(plan.stops[1].days, 10);
    assert.equal(plan.stops[1].unloadChain.get('RAT').amount, 10);
  } finally {
    scope.stop();
  }
});
await check('return surplus leaves room for deliveries picked up at later stops', () => {
  const bs = ['A', 'B', 'C', 'D'].map(id => {
    const site = { siteId: id, address: { id } };
    sitesStore.all.value.push(site);
    fixture.analyses[id] = { suppliesCapDays: 30 };
    return {
      siteId: id,
      naturalId: id,
      planetName: id,
      site,
      config: { days: 5, resupply: true, cxBuy: true },
    };
  });
  fixture.products.A = ['Z'];
  fixture.products.B = ['X'];
  fixture.burns.A = { burn: { Z: { input: 1, output: 2, workforce: 0, inventory: 20 } } };
  fixture.burns.B = { burn: { X: { input: 0, output: 1, workforce: 0, inventory: 100 } } };
  fixture.burns.C = { burn: { Z: { input: 1, output: 0, workforce: 0, inventory: 0 } } };
  fixture.burns.D = { burn: { X: { input: 0.5, output: 0, workforce: 0, inventory: 0 } } };
  fixture.bills.C = config => (config.days > 0 ? { Z: Math.ceil(config.days) } : {});
  fixture.bills.D = config => (config.days > 0 ? { X: Math.ceil(config.days / 2) } : {});
  const vessel = ship('S');
  Object.assign(vessel.cargoStore, { weightCapacity: 15, volumeCapacity: 15 });

  const fiveDays = planChainRoute({
    originNaturalId: 'CX',
    bases: bs,
    capacity: { weight: 15, volume: 15, freeWeight: 15, freeVolume: 15 },
  });
  assert.equal(fiveDays.hasUnmetChainDemand, undefined);
  assert.deepEqual(
    fiveDays.stops.map(stop => stop.naturalId),
    ['A', 'B', 'C', 'D'],
  );
  assert.equal(fiveDays.stops[0].loadOnDeparture.weight, 12);
  assert.equal(fiveDays.stops[1].loadOnArrival.weight, 12);
  assert.equal(fiveDays.stops[1].loadOnDeparture.weight, 15);
  assert.deepEqual(fiveDays.loadOnReturn, { weight: 7, volume: 7 });
  assert.deepEqual(fiveDays.finalUnload, { Z: 7 });

  const scope = effectScope();
  try {
    const planning = scope.run(() =>
      useChainPlanning({ ships: () => [vessel], bases: () => bs, runs: () => [] }),
    );
    const plan = planning.shipPlans.value[0].plan;
    assert.equal(plan.hasUnmetChainDemand, undefined);
    assert.equal(plan.stops[2].days, 10);
    assert.equal(plan.stops[2].unloadChain.get('Z').amount, 10);
    assert.equal(plan.stops[3].unloadChain.get('X').amount, 5);
    assert.deepEqual(plan.peakLoad, { weight: 15, volume: 15 });
  } finally {
    scope.stop();
  }
});
await check('fitting checks stock at a later selected ship’s warehouse', () => {
  const bs = bases();
  for (const base of bs) {
    base.config.resupply = true;
    fixture.analyses[base.siteId] = { suppliesCapDays: 10 };
  }
  fixture.products.A = ['RAT'];
  fixture.burns.A.burn.RAT = { input: 0, output: 2, workforce: 0, inventory: 2 };
  fixture.bills.A = {};
  fixture.bills.B = config => (config.days > 0 ? { RAT: Math.ceil(config.days) } : {});
  const stocked = ship('S2', [{ quantity: { material: { ticker: 'RAT' }, amount: 100 } }]);
  stocked.warehouseStore.id = 'second-warehouse';
  const ships = [ship('S1'), stocked];
  const scope = effectScope();
  try {
    const planning = scope.run(() =>
      useChainPlanning({ ships: () => ships, bases: () => bs, runs: () => [] }),
    );
    const [part] = planning.shipPlans.value;
    assert.equal(part.ship.ship.id, 'S2');
    assert.equal(part.plan.stops[1].days, 10);
    assert.equal(part.plan.originPickup.RAT, 8);
    assert.equal(part.plan.stops[1].unloadChain.get('RAT').amount, 2);
  } finally {
    scope.stop();
  }
});
await check('fitting swaps split segments to use the correct warehouses', () => {
  const bs = bases();
  const producer = { ...bs[0], siteId: 'P', naturalId: 'P', config: { ...bs[0].config } };
  fixture.products.P = ['RAT', 'DW'];
  fixture.burns.P = {
    burn: Object.fromEntries(
      ['RAT', 'DW'].map(ticker => [ticker, { input: 0, output: 1, workforce: 0, inventory: 0 }]),
    ),
  };
  for (const [index, base] of bs.entries()) {
    const ticker = index === 0 ? 'RAT' : 'DW';
    base.config.resupply = true;
    fixture.analyses[base.siteId] = { suppliesCapDays: 1 };
    fixture.bills[base.siteId] = config => (config.days > 0 ? { [ticker]: 1 } : {});
    fixture.burns[base.siteId].burn = {
      [ticker]: { input: 1, output: 0, workforce: 0, inventory: 0, daysLeft: 0 },
    };
  }
  const ships = ['DW', 'RAT'].map((ticker, index) => {
    const vessel = ship(`S${index + 1}`, [{ quantity: { material: { ticker }, amount: 1 } }]);
    vessel.warehouseStore.id = ticker;
    Object.assign(vessel.cargoStore, { weightCapacity: 1, volumeCapacity: 1 });
    return vessel;
  });
  const scope = effectScope();
  try {
    const planning = scope.run(() =>
      useChainPlanning({ ships: () => ships, bases: () => [...bs, producer], runs: () => [] }),
    );
    assert.deepEqual(
      planning.shipPlans.value.map(part => [part.ship.ship.id, part.plan.stops[0].naturalId]),
      [
        ['S2', 'A'],
        ['S1', 'B'],
      ],
    );
  } finally {
    scope.stop();
  }
});
await check('capacity fitting ignores optional return cargo', () => {
  const bs = ['A', 'B', 'C'].map(id => {
    const site = { siteId: id, address: { id } };
    sitesStore.all.value.push(site);
    fixture.analyses[id] = { suppliesCapDays: 1 };
    return {
      siteId: id,
      naturalId: id,
      planetName: id,
      site,
      config: { days: 1, resupply: true, cxBuy: true },
    };
  });
  fixture.bills.A = config => (config.days > 0 ? { M1: 6 } : {});
  fixture.bills.B = config => (config.days > 0 ? { M2: 4 } : {});
  fixture.bills.C = config => (config.days > 0 ? { M3: 10 } : {});
  fixture.products.A = ['Z'];
  fixture.burns.A = { burn: { Z: { input: 0, output: 1, workforce: 0, inventory: 12 } } };
  fixture.burns.B = { burn: { M2: { input: 1, output: 0, workforce: 0, inventory: 0 } } };
  fixture.burns.C = { burn: { M3: { input: 1, output: 0, workforce: 0, inventory: 0 } } };
  const ships = [ship('S1'), ship('S2')];
  for (const vessel of ships) {
    Object.assign(vessel.cargoStore, { weightCapacity: 10, volumeCapacity: 10 });
  }
  const scope = effectScope();
  try {
    const planning = scope.run(() =>
      useChainPlanning({ ships: () => ships, bases: () => bs, runs: () => [] }),
    );
    assert.deepEqual(
      planning.shipPlans.value.map(part => [
        part.ship.ship.id,
        part.plan.stops.map(stop => [stop.naturalId, stop.days]),
      ]),
      [
        [
          'S1',
          [
            ['A', 1],
            ['B', 1],
          ],
        ],
        ['S2', [['C', 1]]],
      ],
    );
    assert.ok(planning.shipPlans.value.every(part => !part.plan.overCapacity));
  } finally {
    scope.stop();
  }
});
await check('capacity fitting counts chain cargo once per segment', () => {
  const bs = ['A', 'B', 'C'].map(id => {
    const site = { siteId: id, address: { id } };
    sitesStore.all.value.push(site);
    fixture.analyses[id] = { suppliesCapDays: 10 };
    return {
      siteId: id,
      naturalId: id,
      planetName: id,
      site,
      config: { days: 10, resupply: true, cxBuy: true },
    };
  });
  fixture.products.A = ['X'];
  fixture.burns.A = { burn: { X: { input: 0, output: 1, workforce: 0, inventory: 100 } } };
  fixture.burns.B = { burn: { X: { input: 1, output: 0, workforce: 0, inventory: 0 } } };
  fixture.burns.C = { burn: { Y: { input: 1, output: 0, workforce: 0, inventory: 0 } } };
  fixture.bills.A = {};
  fixture.bills.B = config => (config.days > 0 ? { X: Math.ceil(config.days) } : {});
  fixture.bills.C = config => (config.days > 0 ? { Y: Math.ceil(config.days) } : {});
  const ships = [ship('S1'), ship('S2')];
  for (const vessel of ships) {
    Object.assign(vessel.cargoStore, { weightCapacity: 10, volumeCapacity: 10 });
  }
  const scope = effectScope();
  try {
    const planning = scope.run(() =>
      useChainPlanning({ ships: () => ships, bases: () => bs, runs: () => [] }),
    );
    const plans = planning.shipPlans.value;
    assert.deepEqual(
      plans.map(part => [part.ship.ship.id, part.plan.stops.map(stop => stop.naturalId)]),
      [
        ['S1', ['A', 'B']],
        ['S2', ['C']],
      ],
    );
    assert.equal(plans[0].plan.stops[1].days, 10);
    assert.equal(plans[0].plan.stops[1].unloadChain.get('X').amount, 10);
    assert.equal(plans[1].plan.stops[0].unloadCx.Y, 10);
    assert.ok(plans.every(part => !part.plan.overCapacity));
  } finally {
    scope.stop();
  }
});
await check('zero supply excludes empty ship plans without creating a run or scripts', async () => {
  const bs = bases();
  const vessel = ship('S');
  fixture.ships.S = vessel.ship;
  fixture.supply['RAT.AI1'] = 0;
  const scope = effectScope();
  const planning = scope.run(() =>
    useChainPlanning({ ships: () => [vessel], bases: () => bs, runs: () => [] }),
  );
  assert.equal(planning.basePlan.value.stops.length, 2);
  assert.deepEqual(planning.shipPlans.value, []);
  assert.equal(planning.hasStops.value, false);
  const result = executeChainPlans(planning.shipPlans.value, {
    autoLaunch: false,
    autoTrigger: false,
  });
  assert.equal(result.plans.length, 0);
  assert.deepEqual(userData.chainRuns, {});
  assert.equal(userData.actionPackages.length, 0);
  assert.equal(userData.triggers.length, 0);
  assert.equal(windows.length, 0);
  scope.stop();
  await nextTick();
});
await check('zero market supply retains deliveries backed by warehouse stock', () => {
  const bs = bases();
  const items = [{ quantity: { material: { ticker: 'RAT' }, amount: 10 } }];
  const vessel = ship('S', items);
  fixture.supply['RAT.AI1'] = 0;
  const plan = planChainRoute({ originNaturalId: 'CX', capacity, bases: bs });
  const plans = splitChainPlanAcrossShips(plan, [vessel], bs);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].plan.stops.length, 1);
  assert.deepEqual(plans[0].plan.originPickup, { RAT: 10 });
  assert.deepEqual(plans[0].plan.purchaseBill, {});
  assert.deepEqual(plans[0].plan.stops[0].unloadCx, { RAT: 10 });
});
await check('clearing selection invalidates pending allocation and flight estimates', async () => {
  const bs = bases();
  const selected = ref([ship('S1'), ship('S2')]);
  let release;
  estimation.pending = new Promise(resolve => {
    release = resolve;
  });
  const scope = effectScope();
  const planning = scope.run(() =>
    useChainPlanning({ ships: () => selected.value, bases: () => bs, runs: () => [] }),
  );
  assert.equal(planning.allocStatus.value, 'computing');
  selected.value = [];
  await nextTick();
  release({ ok: false, legs: [], totalHours: 100, approximatedLegs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(planning.allocStatus.value, 'idle');
  assert.equal(planning.flightEstimates.value.size, 0);
  assert.equal(planning.shipPlans.value.length, 0);
  scope.stop();
});
await check('a disposed planning scope cannot publish its pending result', async () => {
  const bs = bases();
  let release;
  estimation.pending = new Promise(resolve => {
    release = resolve;
  });
  const scope = effectScope();
  const planning = scope.run(() =>
    useChainPlanning({ ships: () => [ship('S1')], bases: () => bs, runs: () => [] }),
  );
  scope.stop();
  release({ ok: false, legs: [], totalHours: 100, approximatedLegs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(planning.flightEstimates.value.size, 0);
});
await check('execution command persists scripts and rejects duplicate runs', () => {
  const bs = bases();
  const vessel = ship('S');
  fixture.ships.S = vessel.ship;
  const plan = planChainRoute({ originNaturalId: 'CX', capacity, bases: bs });
  const result = executeChainPlans([{ ship: vessel, plan }], {
    autoLaunch: false,
    autoTrigger: false,
  });
  assert.equal(result.plans.length, 1);
  assert.equal(userData.chainRuns.S.plan.originLoadOnDeparture.weight, 20);
  assert.equal(userData.actionPackages.length, 3);
  assert.equal(userData.triggers.length, 2);
  assert.equal(windows.length, 1);
  const original = JSON.stringify(userData.chainRuns.S);
  const repeat = executeChainPlans([{ ship: vessel, plan }], {
    autoLaunch: true,
    autoTrigger: true,
  });
  assert.equal(repeat.plans.length, 0);
  assert.equal(JSON.stringify(userData.chainRuns.S), original);
  assert.equal(windows.length, 1);
});
await check('shared runtime survives the component scope that first opened it', async () => {
  syncRun();
  const { getFleetRuntime } = await import('../src/features/XIT/FLEET/chain-runtime.ts');
  const panelScope = effectScope();
  const runtime = panelScope.run(() => getFleetRuntime());
  panelScope.stop();
  assert.equal(getFleetRuntime(), runtime);
  assert.equal(transport.fetches, 0);
  userData.chainRuns.S.originState = 'done';
  await nextTick();
  await runtime.chainSync.pushNow();
  assert.equal(transport.pushes.length, 1);
  assert.equal(transport.pushes[0].doc.chainRuns.S.originState, 'done');
  userData.chainRuns.orphan = {
    shipId: 'orphan',
    originNaturalId: 'CX',
    stops: [],
    mainPkgName: 'missing',
    originState: 'pending',
    finalState: 'pending',
  };
  userData.chainRuns.completed = {
    shipId: 'completed',
    originNaturalId: 'CX',
    stops: [],
    mainPkgName: 'completed',
    originState: 'done',
    finalState: 'done',
  };
  await nextTick();
  assert.equal(userData.chainRuns.orphan, undefined);
  assert.equal(userData.chainRuns.completed.finalState, 'done');
  const fp = userData.chainRuns.S.fp;
  clearShipChainPlan('S', 'S');
  await nextTick();
  assert.equal(userData.chainRuns.S, undefined);
  assert.equal(userData.chainRuns.completed.finalState, 'done');
  assert.equal(userData.actionPackages.length, 0);
  await runtime.chainSync.pushNow();
  assert.equal(transport.pushes.filter(x => x.key === 'S').at(-1).doc.clearedFp, fp);
  runtime.chainSync.stop();
});

// 原生 RT：服务器航线（玩家可能改过）与本地记录合并时，只有输入完全一致才沿用预计时长。
// refuels 项可以是油罐名（补满），也可以是 { tank, limited }（游戏里改成固定数量）。
const refuelsOf = waypoint =>
  (waypoint.refuels ?? []).map(x => (typeof x === 'string' ? { tank: x } : x));

function nativeRouteServer(waypoints) {
  return {
    id: 'route-1',
    naturalId: 'RT-A-1',
    name: 'RT-A-1',
    waypoints: waypoints.map((waypoint, index) => ({
      id: `w${index}`,
      destination: `S|PLA|STA,${waypoint.location}`,
      landing: waypoint.landing ?? true,
      fuelUsageFactor: waypoint.fuelPercent / 100,
      reactorUsageFactor: 0.5,
      preferences: {
        ftlPreference: 'LEAST_JUMPS',
        useGateways: waypoint.useGateways ?? true,
      },
      steps: refuelsOf(waypoint).map(step => ({
        type: 'REFUEL',
        fuel: step.tank,
        minimum: { type: 'CAPACITY', units: 0 },
        maximum: { type: step.limited ? 'ABSOLUTE' : 'CAPACITY', units: step.limited ? 1 : 0 },
      })),
    })),
  };
}

function nativeRouteLocal(waypoints, hours) {
  return {
    routeId: 'route-1',
    naturalId: 'RT-A-1',
    name: 'RT-A-1',
    shipId: 'S',
    shipLabel: 'S',
    chainName: '',
    createdAt: 1,
    waypoints: waypoints.map((waypoint, index) => ({
      location: waypoint.location,
      fuelPercent: waypoint.fuelPercent,
      useGateways: waypoint.useGateways ?? true,
      landing: waypoint.landing ?? true,
      steps: refuelsOf(waypoint).map(step => ({
        kind: 'refuel',
        tank: step.tank,
        ...(step.limited ? { limited: true } : {}),
      })),
      ...(hours[index] === undefined ? {} : { flightHours: hours[index] }),
    })),
  };
}

function mergedHours(localStops, serverStops, hours, executingShipId = 'S') {
  const merged = mergeRouteRecord(
    nativeRouteServer(serverStops),
    executingShipId,
    nativeRouteLocal(localStops, hours),
  );
  return merged.waypoints.map(x => x.flightHours);
}

const stops = (...fuel) =>
  fuel.map((fuelPercent, index) => ({ location: `B${index}`, fuelPercent }));

await check('native RT merge: unchanged route keeps every estimate', async () => {
  const stopsWithFuel = stops(25, 50, 50);
  assert.deepEqual(mergedHours(stopsWithFuel, stopsWithFuel, [undefined, 10, 20]), [
    undefined,
    10,
    20,
  ]);
});

await check('native RT merge: upstream fuel change drops downstream estimates', async () => {
  assert.deepEqual(mergedHours(stops(25, 50, 50), stops(25, 60, 50), [undefined, 10, 20]), [
    undefined,
    undefined,
    undefined,
  ]);
});

await check('native RT merge: refuel stops the invalidation at the refilled tank', async () => {
  const localStops = [
    { location: 'B0', fuelPercent: 25 },
    { location: 'B1', fuelPercent: 50, refuels: ['STL'] },
    { location: 'B2', fuelPercent: 50 },
  ];
  const serverStops = [
    { location: 'B0', fuelPercent: 25 },
    { location: 'B1', fuelPercent: 60, refuels: ['STL'] },
    { location: 'B2', fuelPercent: 50 },
  ];
  assert.deepEqual(mergedHours(localStops, serverStops, [undefined, 10, 20]), [
    undefined,
    undefined,
    20,
  ]);
});

await check(
  'native RT merge: adding an origin refuel drops every downstream estimate',
  async () => {
    const serverStops = [
      { location: 'B0', fuelPercent: 25, refuels: ['STL'] },
      { location: 'B1', fuelPercent: 50 },
      { location: 'B2', fuelPercent: 50 },
    ];
    assert.deepEqual(mergedHours(stops(25, 50, 50), serverStops, [undefined, 10, 20]), [
      undefined,
      undefined,
      undefined,
    ]);
  },
);

await check('native RT merge: a different executing ship drops every estimate', async () => {
  const stopsWithFuel = stops(25, 50, 50);
  assert.deepEqual(mergedHours(stopsWithFuel, stopsWithFuel, [undefined, 10, 20], 'S2'), [
    undefined,
    undefined,
    undefined,
  ]);
});

const legStops = (locations, refuelAt = -1) =>
  locations.map((location, index) => ({
    location,
    fuelPercent: 50,
    ...(index === refuelAt ? { refuels: ['STL', 'FTL'] } : {}),
  }));

await check(
  'native RT merge: an intermediate waypoint change drops every downstream estimate',
  async () => {
    assert.deepEqual(
      mergedHours(legStops(['A', 'B', 'C', 'E']), legStops(['A', 'D', 'C', 'E']), [
        undefined,
        10,
        20,
        30,
      ]),
      [undefined, undefined, undefined, undefined],
    );
  },
);

await check('native RT merge: a refill stops waypoint-change invalidation', async () => {
  assert.deepEqual(
    mergedHours(legStops(['A', 'B', 'C', 'E'], 2), legStops(['A', 'D', 'C', 'E'], 2), [
      undefined,
      10,
      20,
      30,
    ]),
    [undefined, undefined, undefined, 30],
  );
});

await check('native RT merge: a moved refuel waypoint still drops its outgoing leg', async () => {
  // B/D 两个油罐都补满，但从它起飞的那一段已经换了起点，旧时长不能用。
  assert.deepEqual(
    mergedHours(legStops(['A', 'B', 'C', 'E'], 1), legStops(['A', 'D', 'C', 'E'], 1), [
      undefined,
      10,
      20,
      30,
    ]),
    [undefined, undefined, undefined, undefined],
  );
});

await check(
  'native RT merge: a refill switched to a fixed amount drops downstream estimates',
  async () => {
    const localStops = [
      { location: 'A', fuelPercent: 25, refuels: ['STL'] },
      { location: 'B', fuelPercent: 50 },
    ];
    const serverStops = [
      { location: 'A', fuelPercent: 25, refuels: [{ tank: 'STL', limited: true }] },
      { location: 'B', fuelPercent: 50 },
    ];
    assert.deepEqual(mergedHours(localStops, serverStops, [undefined, 10]), [undefined, undefined]);
  },
);

await check('native RT merge: a fixed-amount refill is not an invalidation boundary', async () => {
  const localStops = [
    { location: 'A', fuelPercent: 25, refuels: [{ tank: 'STL', limited: true }] },
    { location: 'B', fuelPercent: 50 },
    { location: 'C', fuelPercent: 50 },
  ];
  const serverStops = localStops.map(x => ({ ...x, fuelPercent: 60 }));
  assert.deepEqual(mergedHours(localStops, serverStops, [undefined, 10, 20]), [
    undefined,
    undefined,
    undefined,
  ]);
});

await check('native RT merge: a landing-mode change drops the adjacent legs', async () => {
  const localStops = [
    { location: 'A', fuelPercent: 25 },
    { location: 'B', fuelPercent: 50 },
    { location: 'C', fuelPercent: 50 },
  ];
  const serverStops = [
    { location: 'A', fuelPercent: 25 },
    { location: 'B', fuelPercent: 50, landing: false },
    { location: 'C', fuelPercent: 50 },
  ];
  assert.deepEqual(mergedHours(localStops, serverStops, [undefined, 10, 20]), [
    undefined,
    undefined,
    undefined,
  ]);
});

await check(
  'native RT merge: a routing preference change drops the leg and downstream',
  async () => {
    const localStops = [
      { location: 'A', fuelPercent: 25 },
      { location: 'B', fuelPercent: 50 },
      { location: 'C', fuelPercent: 50 },
    ];
    const serverStops = [
      { location: 'A', fuelPercent: 25 },
      { location: 'B', fuelPercent: 50, useGateways: false },
      { location: 'C', fuelPercent: 50 },
    ];
    assert.deepEqual(mergedHours(localStops, serverStops, [undefined, 10, 20]), [
      undefined,
      undefined,
      undefined,
    ]);
  },
);

// ---- 运行中进度：A→B→A 的首末同址航线 ----
// 到港后航班从 flightsStore 消失，只看在港位置会把归航误判成「还没出发」。
function nativeRouteProgressCase() {
  const record = {
    routeId: 'route-p',
    naturalId: 'RT-A-P',
    name: 'RT-A-P',
    shipId: 'S',
    shipLabel: 'S',
    chainName: '',
    createdAt: 1,
    waypoints: ['A', 'B', 'A'].map(location => ({
      location,
      fuelPercent: 50,
      steps: [],
    })),
  };
  const ship = { id: 'S', address: { id: 'A' } };
  const docked = at => ({ ...ship, address: { id: at } });
  const flying = (origin, destination) => {
    flightsStore.all.value = [
      { shipId: 'S', origin: { id: origin }, destination: { id: destination }, aborted: false },
    ];
    return ship;
  };
  const arrive = () => {
    flightsStore.all.value = [];
  };
  return { record, docked, flying, arrive };
}

await check('native RT progress: a fresh route at the origin shows stop 1', async () => {
  const { record, docked } = nativeRouteProgressCase();
  assert.deepEqual(routeStopStates(record, docked('A')), ['arrived', 'pending', 'pending']);
  assert.equal(routeProgressText(record, docked('A')), '1/3');
});

await check('native RT progress: arrival at the origin keeps the return-leg position', async () => {
  const { record, docked, flying, arrive } = nativeRouteProgressCase();
  assert.deepEqual(routeStopStates(record, flying('A', 'B')), ['done', 'transit', 'pending']);
  arrive();
  assert.deepEqual(routeStopStates(record, docked('B')), ['done', 'arrived', 'pending']);
  assert.deepEqual(routeStopStates(record, flying('B', 'A')), ['done', 'done', 'transit']);
  arrive();
  assert.deepEqual(routeStopStates(record, docked('A')), ['done', 'done', 'arrived']);
  assert.equal(routeProgressText(record, docked('A')), '3/3');
});

// ---- 「运行中」列表：所有创建过的航线都要出现 ----
function listingRecords() {
  const make = (routeId, naturalId, shipId, createdAt, fuelPercent) => ({
    routeId,
    naturalId,
    name: naturalId,
    shipId,
    shipLabel: shipId,
    chainName: '',
    createdAt,
    waypoints: [
      { location: 'A', fuelPercent, steps: [] },
      { location: 'B', fuelPercent, steps: [] },
    ],
  });
  return {
    'route-1': make('route-1', 'RT-A-1', 'S', 1, 25),
    'route-2': make('route-2', 'RT-A-2', 'S2', 2, 35),
  };
}

await check(
  'native RT listing: every created route is listed without a running snapshot',
  async () => {
    const rows = collectNativeRoutes(listingRecords(), undefined);
    assert.deepEqual(
      rows.map(x => x.record.naturalId),
      ['RT-A-2', 'RT-A-1'],
    );
    assert.deepEqual(
      rows.map(x => x.record.waypoints[0].fuelPercent),
      [35, 25],
    );
  },
);

await check('native RT listing: fetched definitions override unassigned local routes', async () => {
  const rows = collectNativeRoutes(listingRecords(), undefined, [
    nativeRouteServer([
      { location: 'A', fuelPercent: 70 },
      { location: 'B', fuelPercent: 70 },
    ]),
  ]);
  // 游戏里有定义的两条航线都要出现（本地 route-1 + 只存在于游戏里的 route-1 definition 合并），
  // 未在游戏里出现的本地记录（route-2）仍然保留。
  assert.deepEqual(rows.map(x => x.record.naturalId).sort(), ['RT-A-1', 'RT-A-2']);
  const route1 = rows.find(x => x.record.naturalId === 'RT-A-1');
  assert.equal(route1.record.waypoints[0].fuelPercent, 70);
  const route2 = rows.find(x => x.record.naturalId === 'RT-A-2');
  assert.equal(route2.record.waypoints[0].fuelPercent, 35);
});

await check(
  'native RT listing: deleting a route keeps other records on the same ship',
  async () => {
    const records = listingRecords();
    // route-2 与 route-1 同船、同产业链：只删 route-1 时 route-2 的记录必须保留。
    records['route-2'] = { ...records['route-2'], shipId: 'S', chainName: '' };
    records['route-1'] = { ...records['route-1'], chainName: '' };
    assert.deepEqual(recordsToRemoveAfterDelete(records, 'route-1', 'RT-A-1'), ['route-1']);
    // UI 路径记录只有 RT 号：按 RT 号也要能命中唯一一条。
    assert.deepEqual(recordsToRemoveAfterDelete(records, 'RT-A-2', 'RT-A-2'), ['route-2']);
  },
);

await check('native RT listing: two ships on the same route get one card each', async () => {
  const route = nativeRouteServer([
    { location: 'A', fuelPercent: 50 },
    { location: 'B', fuelPercent: 50 },
  ]);
  const rows = collectNativeRoutes(
    listingRecords(),
    {
      entries: [
        { route, shipId: 'S1' },
        { route, shipId: 'S9' },
      ],
      unresolved: 0,
    },
    [route],
  );
  // 两艘船各一张卡；航线定义不再给这条航线补第三张「未分配」卡。
  assert.deepEqual(
    rows.map(x => `${x.record.naturalId}|${x.shipId}`),
    ['RT-A-1|S1', 'RT-A-1|S9', 'RT-A-2|S2'],
  );
});

await check('native RT listing: a deleted route leaves the cached definitions', async () => {
  const deleted = nativeRouteServer([
    { location: 'A', fuelPercent: 50 },
    { location: 'B', fuelPercent: 50 },
  ]);
  const kept = {
    ...nativeRouteServer([
      { location: 'A', fuelPercent: 50 },
      { location: 'B', fuelPercent: 50 },
    ]),
    id: 'route-9',
    naturalId: 'RT-A-9',
  };
  const definitions = withoutRouteDefinition([deleted, kept], 'route-1', 'RT-A-1');
  assert.deepEqual(
    definitions.map(x => x.id),
    ['route-9'],
  );
  assert.deepEqual(
    collectNativeRoutes({}, undefined, definitions).map(x => x.record.naturalId),
    ['RT-A-9'],
  );
});

await check('native RT listing: an executing route wins over its local copy', async () => {
  const records = listingRecords();
  const running = {
    entries: [
      {
        route: {
          id: 'route-1',
          naturalId: 'RT-A-1',
          name: 'RT-A-1',
          waypoints: nativeRouteServer([
            { location: 'A', fuelPercent: 60 },
            { location: 'B', fuelPercent: 60 },
          ]).waypoints,
        },
        shipId: 'S',
      },
    ],
    unresolved: 0,
  };
  const rows = collectNativeRoutes(records, running);
  assert.deepEqual(
    rows.map(x => x.record.naturalId),
    ['RT-A-1', 'RT-A-2'],
  );
  // 执行中的卡片用游戏里的档位，本地那条仍保留自己的值。
  assert.equal(rows[0].record.waypoints[0].fuelPercent, 60);
  assert.equal(rows[1].record.waypoints[0].fuelPercent, 35);
});

// ---- 「运行中」的船来自推送的 assignedRoute（不依赖 RTE 窗口渲染）----
function assignedShip(assignedRoute) {
  const ship = {
    id: 'S1',
    registration: 'AVI-06AGK',
    name: 'Planet-EARTH',
    assignedRoute,
    address: null,
  };
  fixture.ships[ship.id] = ship;
  shipsStore.all.value = [ship];
  return ship;
}

await check('native RT listing: assignedRoute marks the route as executing', async () => {
  const ship = assignedShip('route-1');
  // 游戏 UI 手动创建的航线没有本地记录：只能靠分配把它挂到船上。
  const rows = collectNativeRoutes({}, undefined, [
    nativeRouteServer([
      { location: 'A', fuelPercent: 50 },
      { location: 'B', fuelPercent: 50 },
    ]),
  ]);
  assert.deepEqual(
    rows.map(x => `${x.record.naturalId}|${x.shipId}`),
    ['RT-A-1|S1'],
  );
  // 有船才能按航班定位：A→B 在飞 = 第 2 站 / 共 2 站。
  flightsStore.all.value = [
    { shipId: ship.id, origin: { id: 'A' }, destination: { id: 'B' }, aborted: false },
  ];
  assert.equal(routeProgressText(rows[0].record, shipsStore.getById(rows[0].shipId)), '2/2');
});

await check('native RT listing: assignedRoute may hold the RT number', async () => {
  assignedShip('rt-a-1');
  const rows = collectNativeRoutes(listingRecords(), undefined);
  // 本地记录上记的旧船 S 被推送的分配取代，另一条没有分配的记录不受影响。
  assert.deepEqual(
    rows.map(x => `${x.record.naturalId}|${x.shipId}`),
    ['RT-A-1|S1', 'RT-A-2|S2'],
  );
  assert.equal(rows[0].record.shipId, 'S1');
});

await check('native RT progress: a route without a ship has no position', async () => {
  const rows = collectNativeRoutes({}, undefined, [
    nativeRouteServer([
      { location: 'A', fuelPercent: 50 },
      { location: 'B', fuelPercent: 50 },
    ]),
  ]);
  assert.equal(rows[0].shipId, '');
  // 没有船就无法定位：不能显示 1/N 假装还没出发。
  assert.equal(routeProgressText(rows[0].record, undefined), '—');
});

// ---- 未运行的航线：按出发地装载清单备货 ----
function purchaseRecord(originSteps, stopSteps = []) {
  return {
    routeId: 'route-p',
    naturalId: 'RT-A-P',
    name: 'RT-A-P',
    shipId: '',
    shipLabel: '',
    chainName: '',
    createdAt: 1,
    waypoints: [
      { location: 'HRT', fuelPercent: 50, steps: originSteps },
      { location: 'B', fuelPercent: 50, steps: stopSteps },
    ],
  };
}

await check('native RT purchase: only the origin load steps are bought', async () => {
  const record = purchaseRecord(
    [
      { kind: 'load', ticker: 'RAT', amount: 100 },
      { kind: 'load', ticker: 'DW', amount: 40 },
      { kind: 'unload', ticker: 'OVE', amount: 5 },
      { kind: 'refuel', tank: 'STL' },
      { kind: 'load', ticker: 'FE', amount: 900, capacity: true },
    ],
    [{ kind: 'load', ticker: 'HE3', amount: 7 }],
  );
  // 中途站装的货不在这里买；按容量装载没有确定数量，不能下单。
  assert.deepEqual(nativeRouteOriginBill(record), { RAT: 100, DW: 40 });
});

await check('native RT purchase: the bill is reduced by the origin stock', async () => {
  assert.deepEqual(billShortfall({ RAT: 100, DW: 40 }, { RAT: 60, DW: 40, OVE: 99 }), {
    RAT: 40,
  });
  assert.deepEqual(billShortfall({ RAT: 100 }, { RAT: 120 }), {});
});

await check('native RT purchase: an unplanned route gets a CX Buy package', async () => {
  fixture.stations.HRT = { naturalId: 'HRT', warehouseId: 'station-wh' };
  fixture.exchanges.HRT = { code: 'IC1' };
  fixture.warehouses.HRT = { warehouseId: 'player-wh', storeId: 'wh' };
  // 站级 warehouseId 不是玩家 store id：诱饵库存若被读到说明键型又混了。
  fixture.stores['station-wh'] = {
    id: 'station-wh',
    items: [{ quantity: { material: { ticker: 'RAT' }, amount: 1000 } }],
  };
  fixture.stores.wh = {
    id: 'wh',
    items: [{ quantity: { material: { ticker: 'RAT' }, amount: 30 } }],
  };
  const pkg = nativeRoutePurchasePackage(
    purchaseRecord([
      { kind: 'load', ticker: 'RAT', amount: 100 },
      { kind: 'load', ticker: 'DW', amount: 40 },
    ]),
  );
  assert.deepEqual(pkg.groups[0].materials, { RAT: 70, DW: 40 });
  assert.deepEqual(pkg.actions[0], {
    type: 'CX Buy',
    name: '购买 IC1',
    group: '购买 IC1',
    exchange: 'IC1',
    useCXInv: false,
  });
});

await check('native RT purchase: no package outside a CX or with full stock', async () => {
  const record = purchaseRecord([{ kind: 'load', ticker: 'RAT', amount: 100 }]);
  assert.equal(nativeRoutePurchasePackage(record), undefined);
  fixture.exchanges.HRT = { code: 'IC1' };
  fixture.stations.HRT = { naturalId: 'HRT', warehouseId: 'station-wh' };
  fixture.warehouses.HRT = { warehouseId: 'player-wh', storeId: 'wh' };
  fixture.stores.wh = {
    id: 'wh',
    items: [{ quantity: { material: { ticker: 'RAT' }, amount: 100 } }],
  };
  assert.equal(nativeRoutePurchasePackage(record), undefined);
});

// ---- 「填满库存」：按船适配天数 → 每基地天数（FLEET.vue planConfig 的口径）----
await check('fill inventory: fitted days clamp to each base cap', () => {
  // 单基地：适配值在 cap 内 → 用适配值。
  assert.equal(fillInventoryDays(40, 40, 10), 40);
  // 一船挂多个补给基地：fitDaysForShip 的饱和点取各基地 cap 的最大值，
  // cap 较小的基地必须被钳回自己的上限，否则「目标 40 天 > 仓储上限 25 天」。
  assert.equal(fillInventoryDays(40, 25, 10), 25);
  assert.equal(fillInventoryDays(40, Infinity, 10), 40);
  // 未适配（无船/船不在 CX/缺货舱）：退回仓储上限；无上限则保留手填天数。
  assert.equal(fillInventoryDays(undefined, 25, 10), 25);
  assert.equal(fillInventoryDays(undefined, Infinity, 10), 10);
  assert.equal(fillInventoryDays(undefined, 0, 10), 0);
});

// ---- 原生 RT 循环：周期、每轮账单、备货/支撑轮数、资格、min/max ----
await check('loop cycle converts flight hours to days', () => {
  assert.equal(cycleDaysFromHours(48), 2);
  assert.equal(cycleDaysFromHours(36), 1.5);
});

await check('loop fuel per round sums leg usage and falls back to tank caps', () => {
  const legs = [
    { stlUsed: 10, ftlUsed: 1 },
    { stlUsed: 20, ftlUsed: 2 },
    { stlUsed: 5, ftlUsed: 0 },
  ];
  assert.deepEqual(fuelPerRound(legs, { stlCap: 1500, ftlCap: 300 }), { stl: 35, ftl: 3 });
  // 某油罐缺一段油耗 → 该罐回退上限，另一罐仍按实耗。
  assert.deepEqual(
    fuelPerRound([{ stlUsed: 10 }, { stlUsed: 20, ftlUsed: 2 }], { stlCap: 1500, ftlCap: 300 }),
    { stl: 30, ftl: 300 },
  );
  assert.deepEqual(fuelPerRound([], { stlCap: 1500, ftlCap: 300 }), { stl: 1500, ftl: 300 });
});

await check('loop mode blocks ACT execution with one shared reason', () => {
  assert.equal(actBlockedReason(false), undefined);
  const blocked = actBlockedReason(true);
  assert.equal(typeof blocked, 'string');
  assert.match(blocked, /生成原生 RT/);
  // 守卫的最终落点是 ChainView 的置灰与 execute() 拦截（渲染层，脚本驱动不到）：这里只核对
  // 它确实是唯一来源——一个 computed 派生、置灰不读裸 loopActive、没有第二份硬编码文案。
  const view = readFileSync(
    new URL('../src/features/XIT/FLEET/ChainView.vue', import.meta.url),
    'utf8',
  );
  assert.equal(view.split('actBlockedReason(').length - 1, 1);
  assert.equal(view.includes('循环模式不生成 ACT'), false);
  const hasStopGuards = [...view.matchAll(/:disabled="([^"]*)"/g)]
    .map(match => match[1])
    .filter(expr => expr.includes('hasStops'));
  assert.equal(hasStopGuards.length, 2);
  for (const expr of hasStopGuards) {
    assert.match(expr, /actBlocked !== undefined/);
  }
  assert.equal(view.includes('|| loopActive'), false);
});

await check('loop round bill adds SF/FF to the origin load', () => {
  assert.deepEqual(roundBill({ RAT: 100 }, { stl: 35, ftl: 3 }), { RAT: 100, SF: 35, FF: 3 });
  // cxBill 已含燃料时叠加；零燃料不写键。
  assert.deepEqual(roundBill({ SF: 10 }, { stl: 5, ftl: 0 }), { SF: 15 });
  assert.deepEqual(roundBill({ RAT: 100 }, { stl: 0, ftl: 0 }), { RAT: 100 });
});

await check('loop stocking cap limits rounds to one full ship load', () => {
  const materials = { RAT: { weight: 1, volume: 2 }, SF: { weight: 0.5, volume: 0.5 } };
  const bill = roundBill({ RAT: 10 }, { stl: 4, ftl: 0 });
  const cycle = billWeightVolume(bill, materials);
  assert.deepEqual(cycle, { weight: 12, volume: 22 });
  // min(100/12, 100/22) = 4.54 → 4 轮。
  assert.equal(stockingRoundsMax({ weight: 100, volume: 100 }, cycle), 4);
  // 单轮就超舱 → 至少备 1 轮。
  assert.equal(stockingRoundsMax({ weight: 5, volume: 5 }, cycle), 1);
  assert.equal(stockingRoundsMax({ weight: 100, volume: 100 }, { weight: 0, volume: 0 }), 1);
});

await check('loop sustain rounds follow the first material to run out', () => {
  assert.equal(sustainRounds({ RAT: 10, SF: 5 }, { RAT: 25, SF: 100 }), 2);
  assert.equal(sustainRounds({ RAT: 10 }, { RAT: 0 }), 0);
  assert.equal(sustainRounds({ RAT: 10 }, {}), 0);
  assert.equal(sustainRounds({}, { RAT: 10 }), Infinity);
});

await check('loop full-load usable days weight capacity by net daily need', () => {
  // 总舱容 100t/100m³：单基地净日耗 2t/2m³ → 50 天；两基地相同净日耗 → 25 天。
  const bundle = { weight: 2, volume: 2 };
  assert.equal(fullLoadUsableDays({ weight: 100, volume: 100 }, [bundle]), 50);
  assert.equal(fullLoadUsableDays({ weight: 100, volume: 100 }, [bundle, bundle]), 25);
  // 加权分摊：净日耗 1:3 的两基地按份额分舱 → 各 25 天（均分口径只有 16.7）。
  assert.equal(
    fullLoadUsableDays({ weight: 100, volume: 100 }, [
      { weight: 1, volume: 1 },
      { weight: 3, volume: 3 },
    ]),
    25,
  );
  // 重量/体积取较小：体积瓶颈 100/4 = 25 天。
  assert.equal(fullLoadUsableDays({ weight: 100, volume: 100 }, [{ weight: 2, volume: 4 }]), 25);
  // 自给基地不占分摊：剩一个净消耗基地独享全舱 → 50 天；无基地/全自给 → undefined。
  assert.equal(
    fullLoadUsableDays({ weight: 100, volume: 100 }, [{ weight: 0, volume: 0 }, bundle]),
    50,
  );
  assert.equal(fullLoadUsableDays({ weight: 100, volume: 100 }, []), undefined);
  assert.equal(
    fullLoadUsableDays({ weight: 100, volume: 100 }, [{ weight: 0, volume: 0 }]),
    undefined,
  );
});

await check('loop net daily bundle sums net need with material weight/volume', () => {
  const burn = {
    RAT: { input: 2, workforce: 0.5, output: 0 },
    COF: { input: 1, workforce: 0, output: 1 },
    PG: { input: 3, workforce: 0, output: 1 },
  };
  const bundle = netDailyBundle(burn, t =>
    t === 'RAT' ? { weight: 2, volume: 1 } : { weight: 1, volume: 3 },
  );
  // RAT 净 2.5 → 5t/2.5m³；PG 净 2 → 2t/6m³；COF 自给不计。
  assert.deepEqual(bundle, { weight: 7, volume: 8.5 });
  // 缺重量/体积 → 不出数（宁可显示 —，也不按 0 重量报出偏大的天数）。
  assert.equal(
    netDailyBundle({ RAT: { input: 2, workforce: 0, output: 0 } }, () => undefined),
    undefined,
  );
  // 自给材料缺维度不算缺数据（它不占分摊）。
  assert.deepEqual(
    netDailyBundle({ RAT: { input: 1, workforce: 0, output: 1 } }, () => undefined),
    { weight: 0, volume: 0 },
  );
});

await check('loop sustain leaves fuel out and reports unknown without a per-round snapshot', () => {
  // 游戏里手建的循环航线没有每轮燃料快照：不能拿罐容量当整圈油耗，支撑轮数留空。
  assert.deepEqual(loopSustain({ RAT: 10 }, undefined, { RAT: 100 }), {
    bill: { RAT: 10 },
    sustain: undefined,
  });
  assert.deepEqual(loopSustain({ RAT: 10 }, { stl: 5, ftl: 0 }, { RAT: 100, SF: 100 }), {
    bill: { RAT: 10, SF: 5 },
    sustain: 10,
  });
});

await check(
  'loop eligibility requires one ship, bases, two destinations and a full estimate',
  () => {
    assert.deepEqual(
      loopEligibility({ shipCount: 1, baseCount: 1, distinctDestinations: 2, estimateOk: true }),
      {
        ok: true,
        reasons: [],
      },
    );
    assert.equal(
      loopEligibility({ shipCount: 2, baseCount: 1, distinctDestinations: 2, estimateOk: true }).ok,
      false,
    );
    assert.equal(
      loopEligibility({ shipCount: 1, baseCount: 0, distinctDestinations: 2, estimateOk: true }).ok,
      false,
    );
    assert.equal(
      loopEligibility({ shipCount: 1, baseCount: 1, distinctDestinations: 1, estimateOk: true }).ok,
      false,
    );
    assert.equal(
      loopEligibility({ shipCount: 1, baseCount: 1, distinctDestinations: 2, estimateOk: false })
        .ok,
      false,
    );
  },
);

await check('loop plan balances chain flow on steady net need', () => {
  // B 日耗 RAW 1、库存 5、目标 10 天：单趟 need=ceil(10−5)=5，循环稳态净缺口=ceil(10)=10。
  const mat = (input, output, inventory, daysLeft) => ({
    input,
    output,
    workforce: 0,
    inventory,
    daysLeft,
  });
  const base = (naturalId, burn, products, bill, projectedStock) => ({
    naturalId,
    planetName: naturalId,
    days: 10,
    cxBuy: true,
    burn,
    products,
    bill,
    projectedStock,
    daysUntilFull: Infinity,
  });
  const snapshot = {
    originNaturalId: 'CX',
    capacity,
    originStock: {},
    purchaseStock: {},
    planetRanks: { A: 0, B: 1 },
    materials: { RAW: { weight: 1, volume: 1 } },
    consumers: new Map([['RAW', ['B']]]),
    bases: [
      base('A', { RAW: mat(0, 10, 100, Infinity) }, ['RAW'], {}, { RAW: 100 }),
      base('B', { RAW: mat(1, 0, 5, 5) }, [], { RAW: 10 }, { RAW: 5 }),
    ],
  };
  const single = computeChainPlan(snapshot, String);
  const loop = computeChainPlan({ ...snapshot, loop: true }, String);
  assert.equal(single.stops.find(x => x.naturalId === 'B').unloadChain.get('RAW').amount, 5);
  assert.equal(loop.stops.find(x => x.naturalId === 'B').unloadChain.get('RAW').amount, 10);
  // 提取口径：循环 = 周期×日产（10×10=100）扣已送下游 10 → 运回 90；
  // 单趟 = 到港预计库存装尽（100）扣已送 5 → 运回 95。
  assert.equal(loop.stops.find(x => x.naturalId === 'A').returnLoad.RAW, 90);
  assert.equal(single.stops.find(x => x.naturalId === 'A').returnLoad.RAW, 95);
  // 一次运输实际可用 = 满载加权分摊展示口径：100t/100m³ 仅 B 有净消耗（1t/1m³）独享全舱 → 100 天；单趟不算。
  assert.equal(loop.fullLoadUsableDays, 100);
  assert.equal(single.fullLoadUsableDays, undefined);
});

await check('loop snapshot bills follow cycle × BURN net need, not config days', () => {
  const bs = bases();
  // config.days=10、fixture 账单 RAT:10 都不参与循环口径；人口消耗计入、库存不减。
  fixture.burns.A = {
    burn: { RAT: { input: 1, output: 0, workforce: 0.5, inventory: 99, daysLeft: 0 } },
  };
  const loop = collectChainPlanningSnapshot({
    originNaturalId: 'CX',
    capacity,
    bases: bs,
    loop: true,
    cycleDays: 1.5,
  });
  // ceil(1.5 × 1.5) = 3；B 日耗 1 → ceil(1.5) = 2。
  assert.deepEqual(
    loop.bases.map(b => b.bill),
    [{ RAT: 3 }, { RAT: 2 }],
  );
  assert.deepEqual(
    loop.bases.map(b => b.days),
    [1.5, 1.5],
  );
  // 循环不用到港预计库存（提取按 BURN 日产）。
  assert.deepEqual(
    loop.bases.map(b => b.projectedStock),
    [{}, {}],
  );
  const single = collectChainPlanningSnapshot({ originNaturalId: 'CX', capacity, bases: bs });
  assert.deepEqual(
    single.bases.map(b => b.bill),
    [{ RAT: 10 }, { RAT: 10 }],
  );
});

await check('loop self-produced material delivers net shortfall and extracts net surplus', () => {
  // C 产 RAW 10/日；A 产 RAW 10/日且自耗 12/日（净消耗）；B 耗 2/日。10 天周期。
  // A 净缺口 20 由 C 送达；A 自产 100 全留作一轮生产所需，提取 0。
  const mat = (input, output, daysLeft) => ({
    input,
    output,
    workforce: 0,
    inventory: 0,
    daysLeft,
  });
  const base = (naturalId, burn, products) => ({
    naturalId,
    planetName: naturalId,
    days: 10,
    cxBuy: true,
    burn,
    products,
    bill: {},
    projectedStock: {},
    daysUntilFull: Infinity,
  });
  const snapshot = {
    originNaturalId: 'CX',
    // 舱容放大：本例只验证提取口径，不让返航裁剪干扰断言。
    capacity: { weight: 500, volume: 500, freeWeight: 500, freeVolume: 500 },
    originStock: {},
    purchaseStock: {},
    planetRanks: { C: 0, A: 1, B: 2 },
    materials: { RAW: { weight: 1, volume: 1 } },
    consumers: new Map([['RAW', ['A', 'B']]]),
    bases: [
      base('C', { RAW: mat(0, 10, Infinity) }, ['RAW']),
      base('A', { RAW: mat(12, 10, 1) }, ['RAW']),
      base('B', { RAW: mat(2, 0, 5) }, []),
    ],
    loop: true,
  };
  const plan = computeChainPlan(snapshot, String);
  const a = plan.stops.find(x => x.naturalId === 'A');
  // A 日耗 12、日产 10 → 稳态净缺口 20 由 C 送达；自产部分基地自留一轮生产所需。
  assert.equal(a.unloadChain.get('RAW').amount, 20);
  // A 提取 = 日产 100 − 未被送达覆盖的自用 (120−20) = 0，不运回。
  assert.equal(a.returnLoad.RAW, undefined);
  // 满载加权分摊：500t/500m³ ÷ (A 2 + B 2) = 125 天（C 自产不占分摊）。
  assert.equal(plan.fullLoadUsableDays, 500 / 2 / 2);
  // C 日产 100 送下游 40，余量 60 运回。
  assert.equal(plan.stops.find(x => x.naturalId === 'C').returnLoad.RAW, 60);
});

await check('loop self-sufficient base keeps one round need and extracts net surplus', () => {
  // 单基地自给（日产 10 ≥ 日耗 1）：不安排送达，提取净余量 90，覆盖不计自给材料。
  const snapshot = {
    originNaturalId: 'CX',
    capacity: { weight: 500, volume: 500, freeWeight: 500, freeVolume: 500 },
    originStock: {},
    purchaseStock: {},
    planetRanks: { A: 0 },
    materials: { RAW: { weight: 1, volume: 1 } },
    consumers: new Map(),
    bases: [
      {
        naturalId: 'A',
        planetName: 'A',
        days: 10,
        cxBuy: true,
        burn: { RAW: { input: 1, output: 10, workforce: 0, inventory: 50, daysLeft: Infinity } },
        products: ['RAW'],
        bill: {},
        projectedStock: {},
        daysUntilFull: Infinity,
      },
    ],
    loop: true,
  };
  const plan = computeChainPlan(snapshot, String);
  assert.deepEqual(plan.stops[0].unloadCx, {});
  assert.equal(plan.stops[0].unloadChain.size, 0);
  assert.equal(plan.stops[0].returnLoad.RAW, 90);
  // 全自给基地无净消耗 → 满载分摊无瓶颈可言。
  assert.equal(plan.fullLoadUsableDays, undefined);
});

await check('loop self-sufficient base gets no delivery bill at fractional cycle', () => {
  const site = { siteId: 'A', address: { id: 'A' } };
  sitesStore.all.value.push(site);
  const billOf = (input, output, cycleDays) => {
    fixture.burns.A = {
      burn: { RAT: { input, output, workforce: 0, inventory: 0, daysLeft: 0 } },
    };
    const snapshot = collectChainPlanningSnapshot({
      originNaturalId: 'CX',
      capacity,
      bases: [
        { siteId: 'A', naturalId: 'A', planetName: 'A', site, config: { days: 10, cxBuy: true } },
      ],
      loop: true,
      cycleDays,
    });
    return snapshot.bases[0].bill;
  };
  // 完全自给（日产 = 日耗）与净产（日产 > 日耗）在非整数周期下都不得虚报缺口：
  // 逐项取整 ceil(日耗) − floor(日产) 会在这里给出 { RAT: 1 }。
  assert.deepEqual(billOf(2, 2, 2.4), {});
  assert.deepEqual(billOf(1, 1.1, 1.5), {});
  // 净消耗仍按净缺口向上取整。
  assert.deepEqual(billOf(2, 1, 1.5), { RAT: 2 });
});

await check('loop usable days stay blank when a net-consumer material has no dimensions', () => {
  const snapshot = {
    originNaturalId: 'CX',
    capacity: { weight: 500, volume: 500, freeWeight: 500, freeVolume: 500 },
    originStock: {},
    purchaseStock: {},
    planetRanks: { A: 0 },
    materials: {},
    consumers: new Map(),
    bases: [
      {
        naturalId: 'A',
        planetName: 'A',
        days: 10,
        cxBuy: true,
        burn: { RAW: { input: 2, output: 0, workforce: 0, inventory: 0, daysLeft: Infinity } },
        products: [],
        bill: {},
        projectedStock: {},
        daysUntilFull: Infinity,
      },
    ],
    loop: true,
  };
  // 物料维度没下发：宁可显示 —，也不按 0 重量报出偏大的天数。
  assert.equal(computeChainPlan(snapshot, String).fullLoadUsableDays, undefined);
  const weighed = computeChainPlan(
    { ...snapshot, materials: { RAW: { weight: 2, volume: 1 } } },
    String,
  );
  // 净日耗 2 × 2t = 4t/日 → 500t ÷ 4 = 125 天（体积 250 天，重量先到）。
  assert.equal(weighed.fullLoadUsableDays, 125);
});

await check('loop net producer at fractional cycle neither blocks nor under-extracts', () => {
  // 自产 3/日、自耗 2/日、周期 1.5 天：净余 1.5/轮，不得生成送达缺口（否则整条环线被阻塞）。
  const snapshot = {
    originNaturalId: 'CX',
    capacity: { weight: 500, volume: 500, freeWeight: 500, freeVolume: 500 },
    originStock: {},
    purchaseStock: {},
    planetRanks: { A: 0 },
    materials: { RAW: { weight: 1, volume: 1 } },
    consumers: new Map(),
    bases: [
      {
        naturalId: 'A',
        planetName: 'A',
        days: 1.5,
        cxBuy: true,
        burn: { RAW: { input: 2, output: 3, workforce: 0, inventory: 0, daysLeft: Infinity } },
        products: ['RAW'],
        bill: {},
        projectedStock: {},
        daysUntilFull: Infinity,
      },
    ],
    loop: true,
  };
  const plan = computeChainPlan(snapshot, String);
  assert.equal(plan.hasUnmetChainDemand, undefined);
  assert.deepEqual(plan.stops[0].unloadCx, {});
  assert.equal(plan.stops[0].returnLoad.RAW, 1);
});

await check('loop net-consumer self-produced material picks up shortfall from origin stock', () => {
  // 自产但净消耗（日产 1 < 日耗 12）：净缺口 110 走出发地取货，提取扣送达后为 0。
  const snapshot = {
    originNaturalId: 'CX',
    capacity: { weight: 500, volume: 500, freeWeight: 500, freeVolume: 500 },
    originStock: { COF: 200 },
    purchaseStock: {},
    planetRanks: { A: 0 },
    materials: { COF: { weight: 1, volume: 1 } },
    consumers: new Map(),
    bases: [
      {
        naturalId: 'A',
        planetName: 'A',
        days: 10,
        cxBuy: true,
        burn: { COF: { input: 0, output: 1, workforce: 12, inventory: 0, daysLeft: Infinity } },
        products: ['COF'],
        bill: { COF: 110 },
        projectedStock: {},
        daysUntilFull: Infinity,
      },
    ],
    loop: true,
  };
  const plan = computeChainPlan(snapshot, String);
  assert.equal(plan.stops[0].unloadCx.COF, 110);
  assert.equal(plan.stops[0].returnLoad.COF, undefined);
  assert.equal(plan.fullLoadUsableDays, 500 / 11);
  assert.deepEqual(plan.purchaseBill, {});
});

await check('loop usable days read ship capacity and base BURN, not UNLOAD steps', () => {
  sitesStore.all.value = [{ siteId: 'A', address: { id: 'A' } }];
  fixture.burns.A = {
    burn: { RAT: { input: 2, output: 0, workforce: 0, inventory: 0, daysLeft: 0 } },
  };
  fixture.materials.RAT = { weight: 2, volume: 1 };
  const waypoints = [{ location: 'CX' }, { location: 'A' }, { location: 'CX' }];
  // 单基地独享 100t/100m³：净日耗 4t/2m³ → min(25, 50) = 25 天（与 UNLOAD 步骤量无关）。
  assert.equal(nativeRouteUsableDays(waypoints, { weight: 100, volume: 100 }), 25);
  // 游戏里手建的 Loop 首站就是基地：按基地去重、跳过非基地航点，不再机械跳过首末站。
  sitesStore.all.value.push({ siteId: 'B', address: { id: 'B' } });
  fixture.burns.B = {
    burn: { RAT: { input: 1, output: 0, workforce: 0, inventory: 0, daysLeft: 0 } },
  };
  const baseLoop = [{ location: 'A' }, { location: 'B' }, { location: 'A' }];
  // A 净 2/日 × (2t,1m³) + B 净 1/日 × (2t,1m³) → 100 ÷ 6 = 16.67 天（重量先到）。
  assert.equal(nativeRouteUsableDays(baseLoop, { weight: 100, volume: 100 }), 100 / 6);
  // BURN 未加载 → 不伪造（物料维度缺失的守卫在 netDailyBundle/规划侧断言）。
  delete fixture.burns.A;
  assert.equal(nativeRouteUsableDays(waypoints, { weight: 100, volume: 100 }), undefined);
});

await check(
  'waypoints: each ticker gets one exact-amount step (purchased + chain UNLOAD merge)',
  () => {
    const plan = {
      originNaturalId: 'CX',
      cxBill: { RAT: 14 },
      finalUnload: { FE: 3 },
      stops: [
        {
          naturalId: 'A',
          unloadCx: {},
          unloadChain: new Map(),
          load: new Map([['RAT', { amount: 2 }]]),
        },
        {
          naturalId: 'B',
          unloadCx: { RAT: 14 },
          unloadChain: new Map([['RAT', { amount: 2 }]]),
          load: new Map([['FE', { amount: 3 }]]),
        },
      ],
    };
    // 循环与单趟同口径（用户 2026-11-21 定，取代 2026-11-19 的机会式 min=0/max=Q）：
    // 装卸步骤一律 min=max=计划量，缺料/减产时由步骤原地等待；同 ticker 的采购与链上卸货合并。
    const expected = [
      { location: 'CX', steps: [{ kind: 'load', ticker: 'RAT', amount: 14 }] },
      { location: 'A', steps: [{ kind: 'load', ticker: 'RAT', amount: 2 }] },
      {
        location: 'B',
        steps: [
          { kind: 'unload', ticker: 'RAT', amount: 16 },
          { kind: 'load', ticker: 'FE', amount: 3 },
        ],
      },
      { location: 'CX', steps: [{ kind: 'unload', ticker: 'FE', amount: 3 }] },
    ];
    assert.deepEqual(buildNativeWaypoints(plan), expected);
  },
);

await check(
  'socket step payload: LOAD/UNLOAD send min=max=units, refuel stays CAPACITY',
  async () => {
    // 写入口径的报文断言（用户 2026-11-21 定）：同一个数量同时下发到 minimum 与 maximum，
    // 缺量时由原生步骤原地等待；新建步骤默认 min=1，所以 minimum 必须显式写。
    socketMessages.length = 0;
    const edit = socketEditStep('r1', 'w1', 's1', 'LOAD', 'm1', 42);
    await new Promise(resolve => setTimeout(resolve, 0));
    const sent = socketMessages.at(-1);
    assert.equal(sent.messageType, 'SHIP_ROUTES_EDIT_LOAD_STEP');
    assert.equal(sent.contextId, 'CTX');
    assert.deepEqual(sent.payload.minimum, { type: 'ABSOLUTE', units: 42 });
    assert.deepEqual(sent.payload.maximum, { type: 'ABSOLUTE', units: 42 });
    assert.equal(sent.payload.retain, 0);
    dispatchForce({
      type: 'SHIP_ROUTES_ROUTE',
      data: { id: 'r1', naturalId: 'N1', waypoints: [] },
    });
    assert.equal((await edit).id, 'r1');

    // 补油是唯一例外：上下限都 CAPACITY（= 补满），不带绝对数量。
    const refuel = socketEditRefuelStep('r1', 'w1', 's1', 'STL');
    await new Promise(resolve => setTimeout(resolve, 0));
    const fuel = socketMessages.at(-1).payload;
    assert.deepEqual(fuel.minimum, { type: 'CAPACITY', units: 0 });
    assert.deepEqual(fuel.maximum, { type: 'CAPACITY', units: 0 });
    assert.equal(fuel.source, 'LOCAL_STORE');
    dispatchForce({
      type: 'SHIP_ROUTES_ROUTE',
      data: { id: 'r1', naturalId: 'N1', waypoints: [] },
    });
    await refuel;
  },
);

const loopInput = bs => ({
  ship: { id: 'S', registration: 'S' },
  origin: 'CX',
  bases: bs,
  capacity: { weight: 100, volume: 100, freeWeight: 100, freeVolume: 100 },
  originStock: {},
});
const fakeEstimate =
  hoursOf =>
  async ({ stops }) => {
    const h = hoursOf();
    const legs = [];
    let t = 1_000_000;
    const per = h / (stops.length + 1);
    for (let i = 0; i <= stops.length; i++) {
      legs.push({ ok: true, hours: per, departAtMs: t, arriveAtMs: t + per * 3600000 });
      t += per * 3600000;
    }
    return { ok: true, shipRegistration: 'S', legs, totalHours: h };
  };

await check('loop iteration converges and overrides cycle days', async () => {
  const r = await computeLoopPlan(
    loopInput(bases()),
    fakeEstimate(() => 48),
  );
  assert.equal(r.ok, true);
  assert.equal(r.converged, true);
  assert.equal(r.iterations, 2);
  assert.equal(r.cycleHours, 48);
  // 手填 10 天被飞行周期 48h=2 天覆盖（不写回 config）。
  assert.ok(r.plan.stops.every(s => s.days === 2));
});

await check('loop delivery stays steady while usable days show full load', async () => {
  const r = await computeLoopPlan(
    loopInput(bases()),
    fakeEstimate(() => 48),
  );
  assert.equal(r.ok, true);
  // 装载/补货按稳态：周期 2 天 × 日耗 1 × 2 基地 = 4（不是满载 100）。
  assert.deepEqual(r.plan.cxBill, { RAT: 4 });
  assert.ok(r.plan.stops.every(s => s.unloadCx.RAT === 2));
  // 满载加权只作显示：100 ÷ (1+1) = 50 天。
  assert.equal(r.plan.fullLoadUsableDays, 50);
  // 出发地装载 min=max=计划量（缺料在出发地停跑）。
  assert.deepEqual(buildNativeWaypoints(r.plan)[0].steps, [
    { kind: 'load', ticker: 'RAT', amount: 4 },
  ]);
});

await check('loop iteration keeps last estimate when not converged', async () => {
  const seq = [48, 100, 200];
  let call = 0;
  const r = await computeLoopPlan(
    loopInput(bases()),
    fakeEstimate(() => seq[Math.min(call++, seq.length - 1)]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.converged, false);
  assert.equal(r.iterations, 3);
  assert.equal(r.cycleHours, 200);
  assert.ok(r.warnings.some(w => w.includes('未收敛')));
});

await check('loop blocks when flight estimate is incomplete', async () => {
  const r = await computeLoopPlan(loopInput(bases()), async () => ({
    ok: false,
    shipRegistration: 'S',
    legs: [],
    totalHours: 0,
  }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => x.includes('估时')));
});

await check('loop requires at least one base', async () => {
  const r = await computeLoopPlan(
    loopInput([]),
    fakeEstimate(() => 48),
  );
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => x.includes('基地')));
});

await check('native RT merge: server repeats overrides local loop snapshot', () => {
  const server = { ...nativeRouteServer(stops(25, 50)), repeats: true };
  const local = {
    ...nativeRouteLocal(stops(25, 50), [undefined, 10]),
    loop: true,
    cycleHours: 48,
    repeats: false,
  };
  const merged = mergeRouteRecord(server, 'S', local);
  // Loop 开关以服务端为准（本地 false 被覆盖）；循环标记与周期沿用本地元数据。
  assert.equal(merged.repeats, true);
  assert.equal(merged.loop, true);
  assert.equal(merged.cycleHours, 48);
  // 服务端关闭循环同样覆盖本地开启。
  assert.equal(mergeRouteRecord({ ...server, repeats: false }, 'S', local).repeats, false);
  // 无本地记录（游戏 UI 手建）：只有服务端 repeats，无循环元数据。
  const fresh = mergeRouteRecord(server, 'S', undefined);
  assert.equal(fresh.repeats, true);
  assert.equal(fresh.loop, undefined);
  assert.equal(fresh.cycleHours, undefined);
});

await check('native RT merge: step amount reads from maximum, min range is not recorded', () => {
  const waypoint = steps => ({
    id: 'w0',
    destination: 'S|PLA|STA,B0',
    landing: true,
    fuelUsageFactor: 0.25,
    reactorUsageFactor: 0.5,
    preferences: { ftlPreference: 'LEAST_JUMPS', useGateways: true },
    steps,
  });
  const server = {
    id: 'route-1',
    naturalId: 'RT-A-1',
    name: 'RT-A-1',
    repeats: true,
    waypoints: [
      waypoint([
        {
          type: 'LOAD',
          material: { id: 'm', ticker: 'RAT' },
          minimum: { type: 'ABSOLUTE', units: 0 },
          maximum: { type: 'ABSOLUTE', units: 50 },
        },
        {
          type: 'UNLOAD',
          material: { id: 'm', ticker: 'RAT' },
          minimum: { type: 'ABSOLUTE', units: 50 },
          maximum: { type: 'ABSOLUTE', units: 50 },
        },
      ]),
    ],
  };
  const stepsOut = mergeRouteRecord(server, undefined, undefined).waypoints[0].steps;
  // 玩家手建的 min≠max 也只按 maximum.units 记数量：RPrun 不写、不存弹性区间。
  assert.deepEqual(stepsOut, [
    { kind: 'load', ticker: 'RAT', amount: 50, capacity: undefined },
    { kind: 'unload', ticker: 'RAT', amount: 50, capacity: undefined },
  ]);
});

await check('RTE status parses blocked/waiting candidates, undefined otherwise', () => {
  // 文案待实采校准：先识别手册候选英文关键词，读不到保留 undefined。
  assert.equal(parseRouteStatus('RT-A-1 S1 Step blocked'), 'blocked');
  assert.equal(parseRouteStatus('RT-A-1 S1 Blocked'), 'blocked');
  assert.equal(parseRouteStatus('RT-A-1 S1 Waiting'), 'waiting');
  assert.equal(parseRouteStatus('RT-A-1 S1'), undefined);
});

await check('RTE status flows into running route entries', () => {
  const routes = [nativeRouteServer(stops(25, 50))];
  const rows = [
    { text: 'RT-A-1 S1 Blocked', naturalId: 'RT-A-1', shipId: 'S1', status: 'blocked' },
    { text: 'RT-A-1 S2 Waiting', naturalId: 'RT-A-1', shipId: 'S2', status: 'waiting' },
  ];
  const running = matchRunningRoutes(routes, rows);
  assert.equal(running.entries.length, 2);
  assert.equal(running.entries.find(x => x.shipId === 'S1').status, 'blocked');
  assert.equal(running.entries.find(x => x.shipId === 'S2').status, 'waiting');
});

await check('native RT merge preserves per-round fuel snapshot', () => {
  const server = { ...nativeRouteServer(stops(25, 50)), repeats: true };
  const local = {
    ...nativeRouteLocal(stops(25, 50), [undefined, 10]),
    loop: true,
    fuelPerRound: { stl: 120, ftl: 30 },
  };
  assert.deepEqual(mergeRouteRecord(server, 'S', local).fuelPerRound, { stl: 120, ftl: 30 });
  assert.equal(mergeRouteRecord(server, 'S', undefined).fuelPerRound, undefined);
});

await check('loop bills each base by the cycle, not the hand-entered days', () => {
  const bs = bases();
  for (const base of bs) {
    fixture.bills[base.siteId] = config => ({ RAT: config.days });
  }
  const single = collectChainPlanningSnapshot({ originNaturalId: 'CX', capacity, bases: bs });
  assert.equal(single.bases[0].bill.RAT, 10);
  assert.equal(single.bases[0].days, 10);
  const looped = collectChainPlanningSnapshot({
    originNaturalId: 'CX',
    capacity,
    bases: bs,
    loop: true,
    cycleDays: 2,
  });
  assert.deepEqual(
    looped.bases.map(base => [base.bill.RAT, base.days]),
    [
      [2, 2],
      [2, 2],
    ],
  );
  // 每轮 CX 采购量必须落在周期口径上：2 天 × 2 个基地 = 4，而不是 10 天 × 2 = 20。
  assert.equal(computeChainPlan(looped, String).cxBill.RAT, 4);
});

await check('fuel tank capacity converts tonnes to units and floors the fraction', () => {
  fixture.materials.SF = { weight: 0.06, volume: 10 };
  fixture.materials.FF = { weight: 0.05, volume: 10 };
  fixture.stores.sf = {
    id: 'sf',
    weightCapacity: 210,
    items: [{ type: 'INVENTORY', quantity: { amount: 100 } }],
  };
  fixture.stores.ff = { id: 'ff', weightCapacity: 500, items: [] };
  const fuel = shipFuelRemainingFor({ stlFuelStoreId: 'sf', ftlFuelStoreId: 'ff' });
  // 210 t / 0.06 t/u = 3499.9999999999995 → 整数罐容量 3500 u（带小数尾巴会流进备货账）。
  assert.equal(fuel.stlCap, 3500);
  assert.equal(fuel.stlRemaining, 100);
  assert.equal(fuel.ftlCap, 10000);
  assert.equal(fuel.ftlRemaining, 0);
  assert.equal(shipFuelRemainingFor({}).stlCap, 0);
  assert.equal(shipFuelRemainingFor({}).ftlCap, 0);
});
console.log(`PASS ${passes}/${passes}`);
