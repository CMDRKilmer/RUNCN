// Real FLEET planning, package generation, completion, recovery and sync regressions.
// Usage: node scripts/verify-fleet-contracts.mjs. Exit 0 = PASS; assertions fail with exit 1.
// Stores and HTTP are fixtures; this does not execute browser actions or contact a server.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { effectScope, nextTick } from 'vue';
register('./lib/fleet-loader.mjs', import.meta.url);
const { fixture, userData, sitesStore, transport } = await import('./lib/fleet-stub.mjs');
const { planChainRoute } = await import('../src/features/XIT/FLEET/chain-planner.ts');
const { splitChainPlanAcrossShips } = await import('../src/features/XIT/FLEET/chain-allocation.ts');
const { buildChainActionPackages } = await import('../src/features/XIT/FLEET/chain-actions.ts');
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
let passes = 0;
async function check(name, fn) {
  userData.chainRuns = {};
  userData.actionPackages = [];
  userData.triggers = [];
  Object.assign(fixture, { bills: {}, burns: {}, products: {}, supply: {}, ships: {}, stores: {} });
  Object.assign(transport, { pushes: [], fetches: 0, remote: null, pending: null });
  storage.clear();
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
  runtime.chainSync.stop();
  assert.equal(transport.pushes.length, 1);
  assert.equal(transport.pushes[0].doc.chainRuns.S.originState, 'done');
});
console.log(`PASS ${passes}/${passes}`);
