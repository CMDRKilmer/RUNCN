<script setup lang="ts">
import {
  agentChannelStore,
  channelIdentifier,
  fetchAgentChannel,
} from '@src/infrastructure/prun-api/data/agent-channel';
import { openAgentChannelWithDraft } from '@src/infrastructure/prun-ui/agent-channel-messaging';
import {
  agentReadyPackages,
  getPackageShip,
  isShipAtDestination,
  type PackageDestination,
} from '@src/features/XIT/ACT/agent-sync';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { formatEta } from '@src/utils/format';
import { timestampEachMinute } from '@src/utils/dayjs';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunButton from '@src/components/PrunButton.vue';
import PrunLink from '@src/components/PrunLink.vue';
import ActionBar from '@src/components/ActionBar.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const loading = ref(false);

async function refresh() {
  loading.value = true;
  await fetchAgentChannel();
  loading.value = false;
}

const fetched = computed(() => agentChannelStore.fetched.value);
const inaccessible = computed(() => agentChannelStore.inaccessible.value);

function getEta(pkg: UserData.ActionPackageData, destinationNaturalId: string | undefined) {
  if (!destinationNaturalId) {
    return undefined;
  }
  const ship = getPackageShip(pkg);
  if (isShipAtDestination(ship, destinationNaturalId)) {
    return 'Landed';
  }
  const flight = flightsStore.getById(ship?.flightId);
  if (!flight || getEntityNaturalIdFromAddress(flight.destination) !== destinationNaturalId) {
    return undefined;
  }
  return formatEta(timestampEachMinute.value, flight.arrival.timestamp);
}

// Older posted packages named themselves "Offload <naturalId>" (see mtra.ts history);
// swap the natural id for the same display name shown in the Destination column.
function getDisplayName(
  pkg: UserData.ActionPackageData,
  destination: PackageDestination | undefined,
) {
  const name = pkg.global.name ?? '';
  return destination ? name.replaceAll(destination.naturalId, destination.name) : name;
}

const packages = computed(() =>
  agentReadyPackages.value.map(entry => ({
    ...entry,
    name: getDisplayName(entry.pkg, entry.destination),
    eta: getEta(entry.pkg, entry.destination?.naturalId),
  })),
);

function openPackage(messageId: string) {
  showBuffer(`XIT AGENT ${messageId}`);
}
</script>

<template>
  <ActionBar>
    <PrunButton primary :disabled="loading" @click="refresh">{{
      getI18nValue('RP.AGENT.refresh', 'REFRESH')
    }}</PrunButton>
  </ActionBar>
  <div v-if="inaccessible">
    {{ getI18nValue('RP.AGENT.channelNotSetup', 'The "${id}" channel isn\'t set up yet. Open') }}
    <PrunLink command="COM" inline>COM</PrunLink>,
    {{
      getI18nValue(
        'RP.AGENT.channelHelp',
        'click "new group", add no other members, and name it "${id}".',
      ).replace('${id}', channelIdentifier)
    }}
  </div>
  <LoadingSpinner v-else-if="loading" />
  <div v-else-if="!fetched">{{
    getI18nValue('RP.AGENT.emptyHint', 'Click REFRESH to load the agent channel.')
  }}</div>
  <table v-else>
    <thead>
      <tr>
        <th>{{ getI18nValue('RP.AGENT.name', 'Name') }}</th>
        <th>{{ getI18nValue('RP.AGENT.id', 'Id') }}</th>
        <th>{{ getI18nValue('RP.AGENT.destination', 'Destination') }}</th>
        <th>{{ getI18nValue('RP.AGENT.eta', 'ETA') }}</th>
        <th>{{ getI18nValue('RP.AGENT.executeCol', 'Execute') }}</th>
        <th>{{ getI18nValue('RP.AGENT.dismiss', 'Dismiss') }}</th>
      </tr>
    </thead>
    <tbody v-if="packages.length === 0">
      <tr>
        <td colspan="6">{{ getI18nValue('RP.AGENT.noReady', 'No ready action packages.') }}</td>
      </tr>
    </tbody>
    <tbody v-else>
      <tr v-for="entry in packages" :key="entry.messageId">
        <td>{{ entry.name }}</td>
        <td>{{ entry.id ?? '--' }}</td>
        <td>
          <PrunLink v-if="entry.destination" inline :command="`BS ${entry.destination.naturalId}`">
            {{ entry.destination.name }}
          </PrunLink>
          <template v-else>--</template>
        </td>
        <td>{{ entry.eta ?? '--' }}</td>
        <td>
          <PrunButton v-if="entry.ready" primary @click="openPackage(entry.messageId)">
            {{ getI18nValue('RP.AGENT.open', 'OPEN') }}
          </PrunButton>
          <template v-else>{{
            getI18nValue('RP.AGENT.waiting', 'waiting for ship to land')
          }}</template>
        </td>
        <td>
          <PrunButton v-if="entry.id" dark inline @click="openAgentChannelWithDraft(entry.id)">
            {{ getI18nValue('RP.AGENT.dismissBtn', 'dismiss') }}
          </PrunButton>
          <template v-else>--</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
