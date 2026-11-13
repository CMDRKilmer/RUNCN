// Resolve real FLEET modules in Node; replace only game stores, transport and UI adapters.
// Unknown aliases fail so new production dependencies cannot silently become mocks.
import { readFile } from 'node:fs/promises';
const stub = new URL('./fleet-stub.mjs', import.meta.url).href;
const adapters = new Set([
  '@src/core/burn',
  '@src/core/base-products',
  '@src/core/game-lookups',
  '@src/core/storage-analysis',
  '@src/infrastructure/fio/orbit',
  '@src/infrastructure/prun-api/data/materials',
  '@src/infrastructure/prun-api/data/production',
  '@src/infrastructure/prun-api/data/addresses',
  '@src/infrastructure/prun-api/data/sites',
  '@src/infrastructure/prun-api/data/storage',
  '@src/infrastructure/prun-api/data/cxob',
  '@src/infrastructure/prun-api/data/ships',
  '@src/infrastructure/prun-api/data/flights',
  '@src/infrastructure/prun-api/data/stations',
  '@src/infrastructure/prun-api/data/stars',
  '@src/infrastructure/prun-api/data/warehouses',
  '@src/infrastructure/prun-api/data/flight-test-collector',
  '@src/features/XIT/FLEET/utils',
  '@src/features/XIT/ACT/actions/utils',
  '@src/features/XIT/ACT/utils',
  '@src/store/user-data',
  '@src/store/create-id',
  '@src/utils/format',
  '@src/infrastructure/org-api/chain-sync',
  '@src/infrastructure/org-api/client',
  '@src/infrastructure/org-api/session',
  '@src/infrastructure/prun-ui/buffers',
  '@src/infrastructure/prun-api/data/api-messages',
  '@src/utils/on-node-disconnected',
]);
export function resolve(specifier, context, nextResolve) {
  if (specifier === './chain-flight-time' && context.parentURL.endsWith('use-chain-planning.ts')) {
    return { url: stub, shortCircuit: true };
  }
  if (specifier === '@src/utils/watch') {
    return { url: new URL('../../src/utils/watch.ts', import.meta.url).href, shortCircuit: true };
  }
  if (adapters.has(specifier)) {
    return { url: stub, shortCircuit: true };
  }
  if (specifier === '@src/features/XIT/ACT/trigger-queue') {
    return {
      url: new URL('../../src/features/XIT/ACT/trigger-queue.ts', import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier.startsWith('@src/features/XIT/FLEET/')) {
    return {
      url: new URL(`../../src/${specifier.slice(5)}.ts`, import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (
    (specifier.startsWith('./chain-') || specifier === './staged') &&
    !specifier.endsWith('.ts')
  ) {
    return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
  }
  if (specifier.startsWith('./use-chain-') && !specifier.endsWith('.ts')) {
    return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
  }
  if (specifier.startsWith('./native-route-') && !specifier.endsWith('.ts')) {
    return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
  }
  if (specifier === './utils' && context.parentURL.endsWith('chain-types.ts')) {
    return { url: stub, shortCircuit: true };
  }
  if (specifier.startsWith('@src/')) {
    throw new Error(`Unmapped FLEET adapter: ${specifier}`);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/utils/watch.ts')) {
    // Vite erases type imports and injects Vue auto-imports in production.
    const source = (await readFile(new URL(url), 'utf8')).replace(
      "import { WatchEffect, WatchOptionsBase, WatchStopHandle } from 'vue';",
      "import type { WatchEffect, WatchOptionsBase, WatchStopHandle } from 'vue';\nimport { watch } from 'vue';",
    );
    return { format: 'module-typescript', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
