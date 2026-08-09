<script setup lang="ts">
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import ExecuteActionPackage from '@src/features/XIT/ACT/ExecuteActionPackage.vue';
import { agentReadyPackages, parseChainId } from '@src/features/XIT/ACT/agent-sync';
import { AGENT_DONE } from '@src/features/XIT/ACT/action-steps/AGENT_DONE';
import { OPEN_SFC } from '@src/features/XIT/ACT/action-steps/OPEN_SFC';
import { MTRA_TRANSFER } from '@src/features/XIT/ACT/action-steps/MTRA_TRANSFER';
import { deserializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { ActionStep, configurableValue } from '@src/features/XIT/ACT/shared-types';
import { getPlanetBurn } from '@src/core/burn';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

const parameters = useXitParameters();
const messageId = parameters.join(' ');

// Snapshot once: AGENT_DONE posts a completion marker mid-run, which drops this
// message from agentReadyPackages (meant to hide it from AGENT next time, not kill
// the run in progress). A live computed here would flip `v-if="!entry"` and unmount
// ExecuteActionPackage - and its runner - before the chained OPEN_SFC step could run.
const entry = agentReadyPackages.value.find(x => x.messageId === messageId);

// Build base→ship load transfers classified against planet burn.
// Evaluated when EXECUTE is clicked, before the offload transfers run, so
// freshly offloaded goods are not in the base-store snapshot.
function buildLoadSteps(baseStore: PrunApi.Store, shipStore: PrunApi.Store): ActionStep[] {
  const burn = getPlanetBurn(sitesStore.getById(baseStore.addressableId))?.burn;
  const loadAll: ActionStep[] = [];
  const playerReview: ActionStep[] = [];

  for (const item of baseStore.items) {
    if (!item.quantity) {
      continue;
    }
    const ticker = item.quantity.material.ticker;
    const invAmount = item.quantity.amount;
    if (invAmount <= 0) {
      continue;
    }

    // With burn unavailable (site data not ready), production/consumption stay 0
    // and every ticker falls into the neutral playerReview case.
    const production = burn?.[ticker]?.output ?? 0;
    const consumption = (burn?.[ticker]?.input ?? 0) + (burn?.[ticker]?.workforce ?? 0);

    if (production > 0 && consumption === 0) {
      // Produced only — load everything available at execution time.
      loadAll.push(
        MTRA_TRANSFER({
          from: baseStore.id,
          to: shipStore.id,
          ticker,
          amount: invAmount,
          loadAll: true,
        }),
      );
    } else if (production > consumption && consumption > 0) {
      // Net produced but also consumed — leave a 2-day buffer at the base.
      playerReview.push(
        MTRA_TRANSFER({
          from: baseStore.id,
          to: shipStore.id,
          ticker,
          amount: Math.max(1, Math.floor(invAmount - 2 * consumption)),
          playerReview: true,
        }),
      );
    } else if (production === 0 && consumption === 0) {
      // Neutral (including tickers absent from burn) — player decides.
      playerReview.push(
        MTRA_TRANSFER({
          from: baseStore.id,
          to: shipStore.id,
          ticker,
          amount: invAmount,
          playerReview: true,
        }),
      );
    }
    // Consumed (net-negative or pure input/workforce): ignore.
  }

  return [...loadAll, ...playerReview];
}

const extraSteps = computed(() => {
  if (!entry) {
    return undefined;
  }
  const steps: ActionStep[] = [];
  if (entry.id) {
    steps.push(AGENT_DONE({ id: entry.id }));
  }

  // Resolve ship cargo store from the package's MTRA origin.
  const origin = entry.pkg.actions.find(x => x.type === 'MTRA')?.origin;
  if (origin === undefined || origin === configurableValue) {
    return steps;
  }
  const shipStore = deserializeStorage(origin);
  if (shipStore?.type !== 'SHIP_STORE') {
    return steps;
  }

  // Base store from MTRA dest — needed for the load phase.
  const mtraDest = entry.pkg.actions.find(x => x.type === 'MTRA')?.dest;
  let baseStore: PrunApi.Store | undefined;
  if (mtraDest !== undefined && mtraDest !== configurableValue) {
    const resolved = deserializeStorage(mtraDest);
    if (resolved?.type === 'STORE') {
      baseStore = resolved;
    }
  }

  // Chain destination for OPEN_SFC (optional — SFC still opens without one).
  let destination: string | undefined;
  if (entry.id) {
    const chain = parseChainId(entry.id);
    if (chain) {
      const next = agentReadyPackages.value.find(x => x.id === `${chain.base}-${chain.index + 1}`);
      const nextDest = next?.pkg.actions.find(x => x.type === 'MTRA')?.dest;
      if (nextDest !== undefined && nextDest !== configurableValue && nextDest.endsWith(' Base')) {
        destination = nextDest.slice(0, -' Base'.length);
      }
    }
  }

  if (baseStore) {
    steps.push(...buildLoadSteps(baseStore, shipStore));
  }
  steps.push(OPEN_SFC({ shipId: shipStore.addressableId, destination }));
  return steps;
});
</script>

<template>
  <div v-if="!entry"> Package "{{ messageId }}" not found. Refresh XIT AGENT and try again. </div>
  <ExecuteActionPackage v-else :pkg="entry.pkg" :extra-steps="extraSteps" />
</template>
