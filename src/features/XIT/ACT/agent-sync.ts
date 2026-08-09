// Encodes/decodes ActionPackageData for posting into the refined-agent channel, and
// derives the "ready to run" list AGENT shows from the channel's message history.
import {
  agentChannelStore,
  maxMessageLength,
  fetchAgentChannel,
} from '@src/infrastructure/prun-api/data/agent-channel';
import { configurableValue, groupTargetPrefix } from '@src/features/XIT/ACT/shared-types';
import { deserializeStorage, serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import {
  getEntityNaturalIdFromAddress,
  getEntityNameFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';

const readyMaxAgeMs = 5 * 24 * 60 * 60 * 1000;

// Short structural keys - repeated on every action/group in a package.
const keyToSync = {
  actions: 'a',
  global: 'g',
  groups: 'r',
  name: 'n',
  type: 't',
  group: 'gr',
  origin: 'o',
  dest: 'd',
  exchange: 'x',
  materials: 'm',
  buyMissingFuel: 'bmf',
  buyPartial: 'bp',
  allowUnfilled: 'auf',
  priceLimits: 'pl',
  useCXInv: 'uci',
  useBaseInv: 'ubi',
  advanceDays: 'ad',
  days: 'dy',
  planet: 'p',
  skippable: 'sk',
  exclusions: 'ex',
  consumablesOnly: 'co',
} as const;
const keyFromSync = invert(keyToSync);

// Short codes for the fixed, bounded enums/sentinels that show up on every package.
const valueToSync = {
  [configurableValue]: '?',
  'CX Buy': 'CB',
  MTRA: 'MT',
  Refuel: 'RF',
  'CONT Ship': 'CS',
  'CONT Trade': 'CT',
  Manual: 'MN',
  Resupply: 'RS',
  Repair: 'RP',
  Paste: 'PS',
  AI1: 'A1',
  CI1: 'C1',
  CI2: 'C2',
  IC1: 'I1',
  NC1: 'N1',
  NC2: 'N2',
} as const;
const valueFromSync = invert(valueToSync);

function invert(map: Record<string, string>) {
  return Object.fromEntries(Object.entries(map).map(([full, short]) => [short, full]));
}

function remapKeysDeep(value: unknown, keyMap: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map(item => remapKeysDeep(item, keyMap));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        keyMap[key] ?? key,
        remapKeysDeep(child, keyMap),
      ]),
    );
  }
  return value;
}

function remapValuesDeep(
  value: unknown,
  valueMap: Record<string, string>,
  transformString?: (value: string) => string,
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => remapValuesDeep(item, valueMap, transformString));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        remapValuesDeep(child, valueMap, transformString),
      ]),
    );
  }
  if (typeof value === 'string') {
    const mapped = valueMap[value];
    if (mapped !== undefined) {
      return mapped;
    }
    return transformString ? transformString(value) : value;
  }
  return value;
}

// Origin/dest are built by serializeStorage() as "<display name> <Suffix>" (e.g.
// "Antares Warehouse"). deserializeStorage() resolves the name via *OrName lookups that
// accept a natural id interchangeably with the display name - so swapping in the natural
// id compacts these losslessly without hardcoding every base/warehouse name in the game.
// expandStorageName reverses the swap on receive so step descriptions show display names.
const storageSuffixes = [' Base', ' Warehouse', ' Cargo', ' STL Store', ' FTL Store'] as const;

function compactStorageName(value: string): string {
  const suffix = storageSuffixes.find(x => value.endsWith(x));
  if (!suffix) {
    return value;
  }
  const store = deserializeStorage(value);
  if (!store) {
    return value;
  }
  const naturalId = getStorageNaturalId(store);
  return naturalId ? naturalId + suffix : value;
}

// Mirror of compactStorageName: the wire carries natural ids to stay under the message
// length cap, but the receiving side displays these strings verbatim in step descriptions.
function expandStorageName(value: string): string {
  const suffix = storageSuffixes.find(x => value.endsWith(x));
  if (!suffix) {
    return value;
  }
  const store = deserializeStorage(value);
  return store ? serializeStorage(store) : value;
}

function getStorageNaturalId(store: PrunApi.Store): string | undefined {
  switch (store.type) {
    case 'STORE':
      return getEntityNaturalIdFromAddress(sitesStore.getById(store.addressableId)?.address);
    case 'WAREHOUSE_STORE':
      return getEntityNaturalIdFromAddress(warehousesStore.getById(store.addressableId)?.address);
    default:
      // Ship-based stores (SHIP_STORE/STL/FTL) are looked up by name only, with no
      // natural-id fallback - swapping the name here would break deserializeStorage.
      return undefined;
  }
}

interface AgentSyncEnvelope {
  // Kind: action-package.
  k: 'ap';
  v: 1;
  // Short per-day id (e.g. "a3"); optional for backward compatibility with older posts.
  i?: string;
  p: unknown;
}

// Expand blindly maps every string leaf through valueFromSync, so a user string
// that already equals a short code (e.g. a group named "MN") would come back
// rewritten. Reject the package instead of corrupting it on the round trip.
function findSyncCodeCollision(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSyncCodeCollision(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      const found = findSyncCodeCollision(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value === 'string' && valueFromSync[value] !== undefined) {
    return value;
  }
  return undefined;
}

export function compactActionPackageForSync(pkg: UserData.ActionPackageData): AgentSyncEnvelope {
  const withShortKeys = remapKeysDeep(pkg, keyToSync);
  const withShortValues = remapValuesDeep(withShortKeys, valueToSync, compactStorageName);
  return { k: 'ap', v: 1, p: withShortValues };
}

export function expandActionPackageFromSync(
  envelope: AgentSyncEnvelope,
): UserData.ActionPackageData {
  const withFullValues = remapValuesDeep(envelope.p, valueFromSync, expandStorageName);
  return remapKeysDeep(withFullValues, keyFromSync) as UserData.ActionPackageData;
}

function parseAgentSyncEnvelope(text: string | null): AgentSyncEnvelope | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const json = JSON.parse(text);
    if (json?.k === 'ap' && json?.v === 1) {
      return json as AgentSyncEnvelope;
    }
  } catch {
    // Not every message in the channel is one of ours - plain chat text fails to
    // parse and is ignored.
  }
  return undefined;
}

// Dismissal markers are the entire message body: a short id like "a3", or a chain
// member like "a3-2".
const dismissalMarkerRegex = /^([a-z])(\d{1,2})(-\d{1,2})?$/;

export function parseDismissalMarker(text: string | null | undefined) {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().toLowerCase();
  const match = normalized.match(dismissalMarkerRegex);
  return match ? match[0] : undefined;
}

// Chain member ids: "<base>-<n>" e.g. "c11-2". Base itself is a normal agent id.
export function parseChainId(id: string | undefined): { base: string; index: number } | undefined {
  if (!id) {
    return undefined;
  }
  const match = id.toLowerCase().match(/^([a-z]\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return undefined;
  }
  return { base: match[1]!, index: Number(match[2]) };
}

function getInWindowCutoff() {
  return Date.now() - readyMaxAgeMs;
}

// Collects ids already used by package envelopes or dismissal markers inside the live
// window, so a freshly generated id stays unique for the 5-day retention period.
// Chain members (e.g. "c11-2") also reserve their base ("c11") so generateAgentMessageId
// never hands out a base that still has live chain members.
function collectUsedIds(
  messages: PrunApi.ChannelMessage[],
  cutoff: number,
  reserved?: ReadonlySet<string>,
) {
  const used = new Set<string>();
  const addId = (raw: string) => {
    const id = raw.toLowerCase();
    used.add(id);
    const chain = parseChainId(id);
    if (chain) {
      used.add(chain.base);
    }
  };
  if (reserved) {
    for (const id of reserved) {
      addId(id);
    }
  }
  for (const message of messages) {
    if (message.type !== 'CHAT' || message.time.timestamp < cutoff) {
      continue;
    }
    const envelope = parseAgentSyncEnvelope(message.message);
    if (envelope?.i) {
      addId(String(envelope.i));
    }
    const marker = parseDismissalMarker(message.message);
    if (marker) {
      addId(marker);
    }
  }
  return used;
}

// Id = <letter><dayOfMonth>, e.g. "a3" = first package posted on the 3rd.
export function generateAgentMessageId(reserved?: ReadonlySet<string>) {
  const day = new Date().getDate();
  const messages = agentChannelStore.all.value ?? [];
  const used = collectUsedIds(messages, getInWindowCutoff(), reserved);
  for (let i = 0; i < 26; i++) {
    const id = String.fromCharCode(97 + i) + day;
    if (!used.has(id)) {
      return id;
    }
  }
  throw new Error('All 26 agent message ids for today are in use.');
}

// Allocates one free base id for a run of `count` packages: a single package keeps the
// plain base ("a3"), two or more become chain members ("a3-1" … "a3-n") so XIT AGENT can
// SFC from one stop to the next. Ids are added to `reserved` because the matching posts
// only happen later, at step-execution time.
export async function generateAgentIds(count: number, reserved?: Set<string>): Promise<string[]> {
  await fetchAgentChannel();
  const base = generateAgentMessageId(reserved);
  reserved?.add(base);
  if (count <= 1) {
    return [base];
  }
  const ids = Array.from({ length: count }, (_, i) => `${base}-${i + 1}`);
  for (const id of ids) {
    reserved?.add(id);
  }
  return ids;
}

// Builds the chat message text for a package without posting it, so the caller can
// recover the exact body if the send fails.
export async function buildAgentPackageMessage(
  pkg: UserData.ActionPackageData,
  id?: string,
): Promise<{ id: string; text: string }> {
  // History is needed to pick a free id; no-op when already fetched this session.
  await fetchAgentChannel();
  const resolvedId = id ?? generateAgentMessageId();
  const collision = findSyncCodeCollision(pkg);
  if (collision !== undefined) {
    throw new Error(
      `Action package can't sync: "${collision}" matches a sync short code - rename it.`,
    );
  }
  const { p } = compactActionPackageForSync(pkg);
  // Place `i` right after k/v so it stays near the front of the raw chat message.
  const envelope: AgentSyncEnvelope = { k: 'ap', v: 1, i: resolvedId, p };
  const text = JSON.stringify(envelope);
  if (text.length > maxMessageLength) {
    throw new Error(
      `Action package too large to sync (${text.length} > ${maxMessageLength} chars).`,
    );
  }
  return { id: resolvedId, text };
}

export interface AgentReadyPackage {
  messageId: string;
  pkg: UserData.ActionPackageData;
  ready: boolean;
  id?: string;
  destination?: PackageDestination;
}

export interface PackageDestination {
  naturalId: string;
  name: string;
}

// The base-store side of a package's action(s) is the planet it's headed to (the
// ship-store side is the ship carrying the cargo - see getPackageShip).
export function getPackageDestination(
  pkg: UserData.ActionPackageData,
): PackageDestination | undefined {
  for (const action of pkg.actions) {
    for (const value of [action.origin, action.dest]) {
      const store = deserializeStorage(value);
      if (store?.type === 'STORE') {
        const site = sitesStore.getById(store.addressableId);
        const naturalId = getEntityNaturalIdFromAddress(site?.address);
        if (naturalId) {
          return { naturalId, name: getEntityNameFromAddress(site?.address) ?? naturalId };
        }
      }
    }
  }
  return undefined;
}

export function getPackageShip(pkg: UserData.ActionPackageData): PrunApi.Ship | undefined {
  for (const action of pkg.actions) {
    for (const value of [action.origin, action.dest]) {
      const store = deserializeStorage(value);
      if (store?.type === 'SHIP_STORE') {
        return shipsStore.getById(store.addressableId);
      }
    }
  }
  return undefined;
}

// A ship counts as at the package's destination only when it is grounded there -
// chained per-stop packages share one ship, so each stop must check its own planet.
export function isShipAtDestination(
  ship: PrunApi.Ship | undefined,
  destinationNaturalId: string | undefined,
) {
  if (ship?.flightId) {
    return false;
  }
  if (destinationNaturalId === undefined) {
    return true;
  }
  return getEntityNaturalIdFromAddress(ship?.address ?? undefined) === destinationNaturalId;
}

// Whichever action references a store is what needs to be "ready" (landed at the
// package's destination, for a ship store) before the package makes sense to run -
// e.g. an Auto Offload MTRA whose origin is a ship's cargo hold that's still in
// flight, or already landed but at some other planet than the offload target.
function getReadyState(
  pkg: UserData.ActionPackageData,
  destination: PackageDestination | undefined,
): boolean {
  const storageValues = [pkg.actions.map(x => x.origin), pkg.actions.map(x => x.dest)]
    .flat()
    .filter((x): x is string => !!x && x !== configurableValue && !x.startsWith(groupTargetPrefix));

  for (const value of storageValues) {
    const store = deserializeStorage(value);
    if (store?.type !== 'SHIP_STORE') {
      continue;
    }
    if (!isShipAtDestination(shipsStore.getById(store.addressableId), destination?.naturalId)) {
      return false;
    }
  }
  return true;
}

export const agentReadyPackages = computed<AgentReadyPackage[]>(() => {
  const messages = agentChannelStore.all.value ?? [];
  const cutoff = getInWindowCutoff();

  // Marker id -> latest marker timestamp inside the live window.
  const markers = new Map<string, number>();
  for (const message of messages) {
    if (message.type !== 'CHAT' || message.time.timestamp < cutoff) {
      continue;
    }
    const marker = parseDismissalMarker(message.message);
    if (!marker) {
      continue;
    }
    const prev = markers.get(marker);
    if (prev === undefined || message.time.timestamp > prev) {
      markers.set(marker, message.time.timestamp);
    }
  }

  const result: AgentReadyPackage[] = [];
  for (const message of messages) {
    if (message.type !== 'CHAT' || message.time.timestamp < cutoff) {
      continue;
    }
    const envelope = parseAgentSyncEnvelope(message.message);
    if (!envelope) {
      continue;
    }
    const id = typeof envelope.i === 'string' ? envelope.i.toLowerCase() : undefined;
    // A marker later than the package hides it; earlier markers leave the id free for reuse.
    if (id) {
      const markerTs = markers.get(id);
      if (markerTs !== undefined && markerTs > message.time.timestamp) {
        continue;
      }
    }
    const pkg = expandActionPackageFromSync(envelope);
    const destination = getPackageDestination(pkg);
    result.push({
      messageId: message.messageId,
      pkg,
      ready: getReadyState(pkg, destination),
      id,
      destination,
    });
  }
  return result;
});
