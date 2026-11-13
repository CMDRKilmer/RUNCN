// Real FLEET planning, package generation, completion, recovery, sync and native RT record regressions.
// Usage: node scripts/verify-fleet-contracts.mjs. Exit 0 = PASS; assertions fail with exit 1.
// Stores, HTTP and windows are fixtures. Hook lifecycle cases defer the estimator; flight models have separate regressions.
// Native RT merge cases drive the real record merge against fixture route payloads; they cover duration invalidation only.
// This does not execute browser actions or contact a server.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { effectScope, nextTick, ref } from 'vue';
register('./lib/fleet-loader.mjs', import.meta.url);
const { fixture, userData, sitesStore, shipsStore, transport, windows, estimation } =
  await import('./lib/fleet-stub.mjs');
const { collectChainPlanningSnapshot } = await import('../src/features/XIT/FLEET/chain-data.ts');
const { computeChainPlan } = await import('../src/features/XIT/FLEET/chain-plan-core.ts');
const { useChainPlanning } = await import('../src/features/XIT/FLEET/use-chain-planning.ts');
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
const { mergeRouteRecord } = await import('../src/features/XIT/FLEET/native-route-game.ts');
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
  });
  Object.assign(transport, { pushes: [], fetches: 0, remote: null, pending: null, result: null });
  storage.clear();
  windows.length = 0;
  estimation.calls = [];
  estimation.pending = null;
  estimation.result = null;
  shipsStore.fetched.value = true;
  sitesStore.all.value = [];
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
      landing: true,
      fuelUsageFactor: waypoint.fuelPercent / 100,
      reactorUsageFactor: 0.5,
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

console.log(`PASS ${passes}/${passes}`);
