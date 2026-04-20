<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import {
  fetchTransportRoutes,
  createTransportRoute,
  updateTransportRoute,
  deleteTransportRoute,
  fetchShipStatuses,
  reportShipStatuses,
  updateShipManualStatus,
  fetchTripsForRoute,
  createTrip,
  updateTripStatus,
  createBooking,
  deleteBooking,
  FactionApiError,
} from '../use-faction-api';
import type { TransportRoute, ShipStatusReport, TransportTrip, MemberRole } from '../types';
import $style from '../FactionPanel.module.css';
import css from './FactionTransport.module.css';

const props = defineProps<{ myRole: MemberRole }>();

const routes = ref<TransportRoute[]>([]);
const shipStatuses = ref<ShipStatusReport[]>([]);
const loading = ref(false);
const error = ref('');
const searchQuery = ref('');

// Current user's company name (derived from auth context).
const myCompanyName = ref('');

// Form state.
const showForm = ref(false);
const editingId = ref<string | null>(null);
const formDeparture = ref('');
const formDestination = ref('');
const formRoundTrip = ref(false);
const formFeePerTon = ref('');
const formFeePerM3 = ref('');
const formShipRegistrations = ref<string[]>([]);
const formNotes = ref('');

const isExecutive = computed(() => props.myRole === 'executive');

function toggleShipRegistration(reg: string) {
  const idx = formShipRegistrations.value.indexOf(reg);
  if (idx >= 0) {
    formShipRegistrations.value.splice(idx, 1);
  } else {
    formShipRegistrations.value.push(reg);
  }
}

// Available ships for the dropdown (current user's ships only).
const myShips = computed(() => shipsStore.all.value ?? []);

const filteredRoutes = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  let list = routes.value;
  if (q) {
    list = list.filter(
      r =>
        r.departure.toLowerCase().includes(q) ||
        r.destination.toLowerCase().includes(q) ||
        r.companyName.toLowerCase().includes(q) ||
        (r.username && r.username.toLowerCase().includes(q)) ||
        r.shipRegistrations.some(reg => reg.toLowerCase().includes(q)),
    );
  }
  // Routes with trips go first.
  return [...list].sort((a, b) => {
    const aTrips = getTrips(a.id).length;
    const bTrips = getTrips(b.id).length;
    if (aTrips > 0 && bTrips === 0) return -1;
    if (aTrips === 0 && bTrips > 0) return 1;
    return 0;
  });
});

function getShipStatus(registration?: string): ShipStatusReport | undefined {
  if (!registration) return undefined;
  return shipStatuses.value.find(s => s.shipRegistration === registration);
}

function conditionClass(condition?: number): string {
  if (condition === undefined) return '';
  if (condition >= 0.8) return css.conditionGood;
  if (condition >= 0.5) return css.conditionWarn;
  return css.conditionBad;
}

function formatCondition(condition?: number): string {
  if (condition === undefined) return '--';
  return `${Math.round(condition * 100)}%`;
}

function formatEtaFromNow(eta?: string): string {
  if (!eta) return '';
  const diff = new Date(eta).getTime() - Date.now();
  if (diff <= 0) return '即将到达';
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function canEdit(route: TransportRoute): boolean {
  return route.companyName === myCompanyName.value;
}

function canDelete(route: TransportRoute): boolean {
  return route.companyName === myCompanyName.value || isExecutive.value;
}

async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    const [routesResult, statusResult] = await Promise.all([
      fetchTransportRoutes(),
      fetchShipStatuses(),
    ]);
    routes.value = routesResult.routes;
    shipStatuses.value = statusResult.reports;
    await loadAllTrips();
  } catch (e) {
    if (e instanceof FactionApiError) {
      error.value = e.response.message;
    }
  } finally {
    loading.value = false;
  }
}

function startCreate() {
  editingId.value = null;
  formDeparture.value = '';
  formDestination.value = '';
  formRoundTrip.value = false;
  formFeePerTon.value = '';
  formFeePerM3.value = '';
  formShipRegistrations.value = [];
  formNotes.value = '';
  showForm.value = true;
}

function startEdit(route: TransportRoute) {
  editingId.value = route.id;
  formDeparture.value = route.departure;
  formDestination.value = route.destination;
  formRoundTrip.value = route.roundTrip;
  formFeePerTon.value = String(route.feePerTon);
  formFeePerM3.value = String(route.feePerM3);
  formShipRegistrations.value = [...route.shipRegistrations];
  formNotes.value = route.notes ?? '';
  showForm.value = true;
}

function cancelForm() {
  showForm.value = false;
  editingId.value = null;
}

async function handleSubmit() {
  const feePerTonVal = parseFloat(formFeePerTon.value);
  const feePerM3Val = parseFloat(formFeePerM3.value);
  const feePerTon = Number.isNaN(feePerTonVal) ? 0 : feePerTonVal;
  const feePerM3 = Number.isNaN(feePerM3Val) ? 0 : feePerM3Val;
  if (!formDeparture.value || !formDestination.value) return;

  const data = {
    departure: formDeparture.value,
    destination: formDestination.value,
    roundTrip: formRoundTrip.value,
    feePerTon,
    feePerM3,
    shipRegistrations: formShipRegistrations.value,
    notes: formNotes.value || undefined,
  };

  try {
    if (editingId.value) {
      await updateTransportRoute(editingId.value, data);
    } else {
      await createTransportRoute(data);
    }
    showForm.value = false;
    editingId.value = null;
    await loadData();
  } catch (e) {
    if (e instanceof FactionApiError) {
      error.value = e.response.message;
    }
  }
}

async function handleDelete(id: string) {
  try {
    await deleteTransportRoute(id);
    await loadData();
  } catch (e) {
    if (e instanceof FactionApiError) {
      error.value = e.response.message;
    }
  }
}

const reportingStatus = ref(false);

async function handleReportShips() {
  const ships = shipsStore.all.value ?? [];
  if (ships.length === 0 || !myCompanyName.value) return;

  reportingStatus.value = true;
  try {
    const reports = ships.map(ship => {
      const flight = ship.flightId ? flightsStore.getById(ship.flightId) : undefined;
      const cargoStores = storagesStore.getByAddressableId(ship.id);
      const cargoStore = cargoStores?.find(s => s.type === 'SHIP_STORE');
      return {
        companyName: myCompanyName.value,
        shipRegistration: ship.registration,
        shipName: ship.name,
        condition: ship.condition,
        location: getEntityNameFromAddress(ship.address ?? undefined) ?? undefined,
        isFlying: !!ship.flightId,
        flightDestination: flight
          ? (getEntityNameFromAddress(flight.destination) ?? undefined)
          : undefined,
        flightEta: flight ? new Date(flight.arrival.timestamp).toISOString() : undefined,
        cargoVolume: cargoStore?.volumeCapacity,
        cargoWeight: cargoStore?.weightCapacity,
      };
    });
    await reportShipStatuses(reports);
    await loadData();
  } catch (e) {
    if (e instanceof FactionApiError) {
      error.value = e.response.message;
    }
  } finally {
    reportingStatus.value = false;
  }
}

async function handleManualStatusChange(shipRegistration: string, event: Event) {
  const value = (event.target as HTMLInputElement).value.trim() || null;
  try {
    await updateShipManualStatus(shipRegistration, value);
    await loadData();
  } catch (e) {
    if (e instanceof FactionApiError) {
      error.value = e.response.message;
    }
  }
}

// --- Trip & Booking state ---
const tripsByRoute = ref<Record<string, TransportTrip[]>>({});

// Trip creation form
const showTripForm = ref<string | null>(null); // routeId or null
const tripDepartureMode = ref<'countdown' | 'schedule'>('countdown');
const tripCountdownHours = ref('');
const tripCountdownMinutes = ref('');
const tripDepartureTime = ref('');
const tripAvailableVolume = ref('');
const tripAvailableWeight = ref('');
const tripDescription = ref('');

// Booking form
const showBookingForm = ref<string | null>(null); // tripId or null
const bookingVolume = ref('');
const bookingWeight = ref('');
const bookingCargoDesc = ref('');

function getTrips(routeId: string): TransportTrip[] {
  return tripsByRoute.value[routeId] ?? [];
}

function remainingVolume(trip: TransportTrip): number {
  const used = trip.bookings.reduce((sum, b) => sum + b.volume, 0);
  return Math.max(0, trip.availableVolume - used);
}

function remainingWeight(trip: TransportTrip): number {
  const used = trip.bookings.reduce((sum, b) => sum + b.weight, 0);
  return Math.max(0, trip.availableWeight - used);
}

function capacityPercent(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function formatDepartureTime(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

// Live countdown.
const now = ref(Date.now());
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function startCountdownTimer() {
  countdownTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}

onUnmounted(() => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }
});

function formatCountdown(iso: string): string {
  const diff = new Date(iso).getTime() - now.value;
  if (diff <= 0) {
    return '\u5df2\u51fa\u53d1';
  }
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  return `${m}m ${s}s`;
}

function isDeparted(iso: string): boolean {
  return new Date(iso).getTime() <= now.value;
}

async function loadTripsForRoute(routeId: string) {
  try {
    const result = await fetchTripsForRoute(routeId);
    tripsByRoute.value[routeId] = result.trips;
  } catch {
    // silently fail for individual route trips
  }
}

async function loadAllTrips() {
  await Promise.all(routes.value.map(r => loadTripsForRoute(r.id)));
}

function startTripCreate(routeId: string, ship?: ShipStatusReport) {
  showTripForm.value = routeId;
  tripDepartureMode.value = 'countdown';
  tripCountdownHours.value = '';
  tripCountdownMinutes.value = '';
  tripDepartureTime.value = '';
  tripAvailableVolume.value = ship?.cargoVolume !== undefined ? String(ship.cargoVolume) : '';
  tripAvailableWeight.value = ship?.cargoWeight !== undefined ? String(ship.cargoWeight) : '';
  tripDescription.value = '';
}

function cancelTripForm() {
  showTripForm.value = null;
}

function computedDepartureISO(): string | null {
  if (tripDepartureMode.value === 'countdown') {
    const hVal = parseInt(tripCountdownHours.value);
    const mVal = parseInt(tripCountdownMinutes.value);
    const h = Number.isNaN(hVal) ? 0 : hVal;
    const m = Number.isNaN(mVal) ? 0 : mVal;
    if (h <= 0 && m <= 0) {
      return null;
    }
    return new Date(Date.now() + h * 3600000 + m * 60000).toISOString();
  }
  if (!tripDepartureTime.value) {
    return null;
  }
  return new Date(tripDepartureTime.value).toISOString();
}

const canSubmitTrip = computed(() => {
  if (tripDepartureMode.value === 'countdown') {
    const hVal = parseInt(tripCountdownHours.value);
    const mVal = parseInt(tripCountdownMinutes.value);
    const h = Number.isNaN(hVal) ? 0 : hVal;
    const m = Number.isNaN(mVal) ? 0 : mVal;
    return h > 0 || m > 0;
  }
  return !!tripDepartureTime.value;
});

async function handleCreateTrip(routeId: string) {
  const volumeVal = parseFloat(tripAvailableVolume.value);
  const weightVal = parseFloat(tripAvailableWeight.value);
  const volume = Number.isNaN(volumeVal) ? 0 : volumeVal;
  const weight = Number.isNaN(weightVal) ? 0 : weightVal;
  const departureISO = computedDepartureISO();
  if (!departureISO || volume <= 0 || weight <= 0) {
    return;
  }

  try {
    await createTrip(routeId, {
      departureTime: departureISO,
      availableVolume: volume,
      availableWeight: weight,
      description: tripDescription.value || undefined,
    });
    showTripForm.value = null;
    await loadTripsForRoute(routeId);
  } catch (e) {
    if (e instanceof FactionApiError) error.value = e.response.message;
  }
}

async function handleCloseTripStatus(
  tripId: string,
  routeId: string,
  status: 'closed' | 'cancelled',
) {
  try {
    await updateTripStatus(tripId, status);
    await loadTripsForRoute(routeId);
  } catch (e) {
    if (e instanceof FactionApiError) error.value = e.response.message;
  }
}

function startBooking(tripId: string) {
  showBookingForm.value = tripId;
  bookingVolume.value = '';
  bookingWeight.value = '';
  bookingCargoDesc.value = '';
}

function cancelBookingForm() {
  showBookingForm.value = null;
}

async function handleCreateBooking(tripId: string, routeId: string) {
  const volumeVal = parseFloat(bookingVolume.value);
  const weightVal = parseFloat(bookingWeight.value);
  const volume = Number.isNaN(volumeVal) ? 0 : volumeVal;
  const weight = Number.isNaN(weightVal) ? 0 : weightVal;
  if (volume <= 0 && weight <= 0) return;

  try {
    await createBooking(tripId, {
      volume,
      weight,
      cargoDescription: bookingCargoDesc.value || undefined,
    });
    showBookingForm.value = null;
    await loadTripsForRoute(routeId);
  } catch (e) {
    if (e instanceof FactionApiError) error.value = e.response.message;
  }
}

async function handleDeleteBooking(bookingId: string, routeId: string) {
  try {
    await deleteBooking(bookingId);
    await loadTripsForRoute(routeId);
  } catch (e) {
    if (e instanceof FactionApiError) error.value = e.response.message;
  }
}

// Detect my company name from Supabase auth session.
// We extract it by finding my routes or from the members API response.
// Simplest: use the game's company store.
import { companyStore } from '@src/infrastructure/prun-api/data/company';
watchEffect(() => {
  const company = companyStore.value;
  if (company) {
    myCompanyName.value = company.name;
  }
});

onMounted(() => {
  loadData();
  startCountdownTimer();
});
</script>

<template>
  <div>
    <!-- Toolbar -->
    <div :class="$style.membersToolbar">
      <div style="display: flex; gap: 4px; align-items: center">
        <PrunButton dark @click="loadData">刷新</PrunButton>
        <input
          v-model="searchQuery"
          :class="$style.fieldInput"
          type="text"
          placeholder="搜索路线..."
          style="width: 140px" />
      </div>
      <div style="display: flex; gap: 4px">
        <PrunButton dark :disabled="reportingStatus" @click="handleReportShips">
          {{ reportingStatus ? '上报中...' : '上报状态' }}
        </PrunButton>
        <PrunButton dark @click="startCreate">发布路线 +</PrunButton>
      </div>
    </div>

    <!-- Create/Edit form -->
    <div v-if="showForm" :class="$style.loginContainer">
      <div :class="css.formRow">
        <div :class="css.formHalf">
          <div :class="$style.field">
            <div :class="$style.fieldLabel">出发地</div>
            <input
              v-model="formDeparture"
              :class="$style.fieldInput"
              type="text"
              placeholder="如 Montem" />
          </div>
        </div>
        <div :class="css.formHalf">
          <div :class="$style.field">
            <div :class="$style.fieldLabel">目的地</div>
            <input
              v-model="formDestination"
              :class="$style.fieldInput"
              type="text"
              placeholder="如 Promitor" />
          </div>
        </div>
      </div>

      <label :class="css.checkboxRow">
        <input v-model="formRoundTrip" type="checkbox" />
        往返
      </label>

      <div :class="css.formRow">
        <div :class="css.formHalf">
          <div :class="$style.field">
            <div :class="$style.fieldLabel">每吨费用</div>
            <input
              v-model="formFeePerTon"
              :class="$style.fieldInput"
              type="number"
              min="0"
              step="0.01" />
          </div>
        </div>
        <div :class="css.formHalf">
          <div :class="$style.field">
            <div :class="$style.fieldLabel">每m³费用</div>
            <input
              v-model="formFeePerM3"
              :class="$style.fieldInput"
              type="number"
              min="0"
              step="0.01" />
          </div>
        </div>
      </div>

      <div :class="$style.field">
        <div :class="$style.fieldLabel">绑定飞船（可选，可多选）</div>
        <div :class="css.shipCheckboxList">
          <label v-for="ship in myShips" :key="ship.id" :class="css.shipCheckboxItem">
            <input
              type="checkbox"
              :value="ship.registration"
              :checked="formShipRegistrations.includes(ship.registration)"
              @change="toggleShipRegistration(ship.registration)" />
            {{ ship.registration }} - {{ ship.name }}
          </label>
        </div>
      </div>

      <div :class="$style.field">
        <div :class="$style.fieldLabel">备注（可选）</div>
        <textarea
          v-model="formNotes"
          :class="css.notesInput"
          rows="2"
          placeholder="运输备注信息..." />
      </div>

      <div :class="$style.buttonRow">
        <PrunButton dark @click="cancelForm">取消</PrunButton>
        <PrunButton primary :disabled="!formDeparture || !formDestination" @click="handleSubmit">
          {{ editingId ? '更新' : '发布' }}
        </PrunButton>
      </div>
    </div>

    <div v-if="error" :class="$style.errorMessage">{{ error }}</div>

    <div v-if="loading" :class="$style.loadingMessage">加载中...</div>

    <template v-else>
      <div v-if="filteredRoutes.length === 0" :class="$style.emptyMessage">暂无运输路线</div>

      <div :class="css.routeGrid">
        <div v-for="route in filteredRoutes" :key="route.id" :class="css.routeCard">
          <!-- Card header: owner + actions -->
          <div :class="css.cardHeader">
            <div :class="css.cardOwner">
              <span>{{ route.companyName }}</span>
              <span v-if="route.username" :class="css.ownerUsername">{{ route.username }}</span>
            </div>
            <div :class="css.cardActions">
              <PrunButton v-if="canEdit(route)" dark @click="startEdit(route)">编辑</PrunButton>
              <PrunButton v-if="canDelete(route)" danger @click="handleDelete(route.id)"
                >删除</PrunButton
              >
            </div>
          </div>

          <!-- Route info -->
          <div :class="css.routeInfo">
            <span :class="css.routeLocation">{{ route.departure }}</span>
            <span :class="css.routeArrow">→</span>
            <span :class="css.routeLocation">{{ route.destination }}</span>
            <span v-if="route.roundTrip" :class="css.roundTripBadge">往返</span>
          </div>

          <!-- Fee info -->
          <div :class="css.feeInfo"> {{ route.feePerTon }}/t · {{ route.feePerM3 }}/m³ </div>

          <!-- Notes -->
          <div v-if="route.notes" :class="css.routeNotes">
            {{ route.notes }}
          </div>

          <!-- Ship status (if bound) -->
          <div v-for="reg in route.shipRegistrations" :key="reg" :class="css.shipStatus">
            <template v-if="getShipStatus(reg)">
              <div :class="css.shipHeader">
                <span :class="css.shipReg">{{ getShipStatus(reg)!.shipRegistration }}</span>
                <span v-if="getShipStatus(reg)!.shipName" :class="css.shipName">
                  {{ getShipStatus(reg)!.shipName }}
                </span>
                <span :class="[css.shipCondition, conditionClass(getShipStatus(reg)!.condition)]">
                  {{ formatCondition(getShipStatus(reg)!.condition) }}
                </span>
                <span v-if="getShipStatus(reg)!.location" :class="css.shipName">
                  {{ getShipStatus(reg)!.location }}
                </span>
              </div>
              <div :class="css.shipFlight">
                <template v-if="getShipStatus(reg)!.isFlying">
                  <span :class="css.flyingBadge">飞行中</span>
                  → {{ getShipStatus(reg)!.flightDestination }} · ETA
                  {{ formatEtaFromNow(getShipStatus(reg)!.flightEta) }}
                </template>
                <template v-else>
                  <span :class="css.idleBadge">停靠中</span>
                </template>
                <template v-if="getShipStatus(reg)!.cargoVolume">
                  · {{ getShipStatus(reg)!.cargoVolume }}m³
                </template>
                <template v-if="getShipStatus(reg)!.cargoWeight">
                  / {{ getShipStatus(reg)!.cargoWeight }}t
                </template>
                <span
                  v-if="getShipStatus(reg)!.manualStatus && !canEdit(route)"
                  :class="css.manualStatusBadge">
                  {{ getShipStatus(reg)!.manualStatus }}
                </span>
              </div>
              <div
                v-if="canEdit(route)"
                style="
                  margin-top: 1px;
                  display: flex;
                  align-items: center;
                  gap: 4px;
                  font-size: 10px;
                  opacity: 0.7;
                ">
                状态:
                <input
                  :class="css.statusInput"
                  type="text"
                  placeholder="手动状态"
                  :value="getShipStatus(reg)!.manualStatus ?? ''"
                  @blur="handleManualStatusChange(reg, $event)"
                  @keyup.enter="($event.target as HTMLInputElement).blur()" />
              </div>
            </template>
            <div v-else :class="css.shipName"> {{ reg }} · 等待状态上报... </div>
          </div>

          <!-- Trips section -->
          <div :class="css.tripSection">
            <!-- Existing trips -->
            <div v-for="trip in getTrips(route.id)" :key="trip.id" :class="css.tripCard">
              <div :class="css.tripHeader">
                <span
                  :class="[css.tripCountdown, isDeparted(trip.departureTime) ? css.departed : '']">
                  {{ formatCountdown(trip.departureTime) }}
                </span>
                <span :class="css.tripTime">{{ formatDepartureTime(trip.departureTime) }}</span>
                <span :class="css.tripOwner">{{ trip.companyName }}</span>
                <span v-if="trip.description" :class="css.tripDesc">{{ trip.description }}</span>
              </div>

              <!-- Capacity bars -->
              <div :class="css.capacityRow">
                <span :class="css.capacityLabel">体积</span>
                <div :class="css.capacityBar">
                  <div
                    :class="css.capacityFill"
                    :style="{
                      width:
                        capacityPercent(
                          trip.availableVolume - remainingVolume(trip),
                          trip.availableVolume,
                        ) + '%',
                      backgroundColor:
                        remainingVolume(trip) > 0 ? 'rgb(146, 196, 125)' : 'rgb(217, 83, 79)',
                    }" />
                </div>
                <span :class="css.capacityText"
                  >{{ Math.round(remainingVolume(trip)) }}/{{ trip.availableVolume }}m³</span
                >
              </div>
              <div :class="css.capacityRow">
                <span :class="css.capacityLabel">重量</span>
                <div :class="css.capacityBar">
                  <div
                    :class="css.capacityFill"
                    :style="{
                      width:
                        capacityPercent(
                          trip.availableWeight - remainingWeight(trip),
                          trip.availableWeight,
                        ) + '%',
                      backgroundColor:
                        remainingWeight(trip) > 0 ? 'rgb(146, 196, 125)' : 'rgb(217, 83, 79)',
                    }" />
                </div>
                <span :class="css.capacityText"
                  >{{ Math.round(remainingWeight(trip)) }}/{{ trip.availableWeight }}t</span
                >
              </div>

              <!-- Booking list -->
              <div v-if="trip.bookings.length > 0" :class="css.bookingList">
                <div v-for="b in trip.bookings" :key="b.id" :class="css.bookingRow">
                  <span :class="css.bookingCompany">{{ b.companyName }}</span>
                  <span :class="css.bookingAmount">{{ b.volume }}m³ {{ b.weight }}t</span>
                  <span v-if="b.cargoDescription" :class="css.bookingCargo">{{
                    b.cargoDescription
                  }}</span>
                  <PrunButton
                    v-if="b.companyName === myCompanyName"
                    danger
                    style="font-size: 9px; padding: 0 3px"
                    @click="handleDeleteBooking(b.id, route.id)">
                    取消
                  </PrunButton>
                </div>
              </div>

              <!-- Booking form (inline) -->
              <div v-if="showBookingForm === trip.id" :class="css.bookingForm">
                <div :class="css.formRow">
                  <input
                    v-model="bookingVolume"
                    :class="css.statusInput"
                    type="number"
                    min="0"
                    placeholder="m³"
                    style="width: 60px" />
                  <input
                    v-model="bookingWeight"
                    :class="css.statusInput"
                    type="number"
                    min="0"
                    placeholder="t"
                    style="width: 60px" />
                  <input
                    v-model="bookingCargoDesc"
                    :class="css.statusInput"
                    type="text"
                    placeholder="货物"
                    style="width: 60px" />
                </div>
                <div style="display: flex; gap: 4px; margin-top: 4px">
                  <PrunButton dark @click="cancelBookingForm">取消</PrunButton>
                  <PrunButton primary @click="handleCreateBooking(trip.id, route.id)"
                    >确认</PrunButton
                  >
                </div>
              </div>

              <!-- Trip actions -->
              <div :class="css.tripActions">
                <PrunButton
                  v-if="showBookingForm !== trip.id && remainingVolume(trip) > 0"
                  dark
                  @click="startBooking(trip.id)">
                  预订舱位
                </PrunButton>
                <PrunButton
                  v-if="trip.companyName === myCompanyName"
                  danger
                  @click="handleCloseTripStatus(trip.id, route.id, 'closed')">
                  关闭航班
                </PrunButton>
              </div>
            </div>

            <!-- Create trip button / form -->
            <template v-if="canEdit(route)">
              <div v-if="showTripForm === route.id" :class="css.tripFormContainer">
                <div :class="css.modeSwitch">
                  <span
                    :class="[
                      css.modeOption,
                      tripDepartureMode === 'countdown' ? css.modeActive : '',
                    ]"
                    @click="tripDepartureMode = 'countdown'">
                    倒计时
                  </span>
                  <span
                    :class="[
                      css.modeOption,
                      tripDepartureMode === 'schedule' ? css.modeActive : '',
                    ]"
                    @click="tripDepartureMode = 'schedule'">
                    预约时间
                  </span>
                </div>
                <div v-if="tripDepartureMode === 'countdown'" :class="css.formRow">
                  <div :class="css.formHalf">
                    <div :class="$style.field">
                      <div :class="$style.fieldLabel">小时</div>
                      <input
                        v-model="tripCountdownHours"
                        :class="$style.fieldInput"
                        type="number"
                        min="0"
                        placeholder="0" />
                    </div>
                  </div>
                  <div :class="css.formHalf">
                    <div :class="$style.field">
                      <div :class="$style.fieldLabel">分钟</div>
                      <input
                        v-model="tripCountdownMinutes"
                        :class="$style.fieldInput"
                        type="number"
                        min="0"
                        max="59"
                        placeholder="0" />
                    </div>
                  </div>
                </div>
                <div v-else :class="$style.field">
                  <div :class="$style.fieldLabel">出发时间</div>
                  <input
                    v-model="tripDepartureTime"
                    :class="$style.fieldInput"
                    type="datetime-local" />
                </div>
                <div :class="css.formRow">
                  <div :class="css.formHalf">
                    <div :class="$style.field">
                      <div :class="$style.fieldLabel">可用体积 (m³)</div>
                      <input
                        v-model="tripAvailableVolume"
                        :class="$style.fieldInput"
                        type="number"
                        min="0" />
                    </div>
                  </div>
                  <div :class="css.formHalf">
                    <div :class="$style.field">
                      <div :class="$style.fieldLabel">可用重量 (t)</div>
                      <input
                        v-model="tripAvailableWeight"
                        :class="$style.fieldInput"
                        type="number"
                        min="0" />
                    </div>
                  </div>
                </div>
                <div :class="$style.field">
                  <div :class="$style.fieldLabel">说明（可选）</div>
                  <input
                    v-model="tripDescription"
                    :class="$style.fieldInput"
                    type="text"
                    placeholder="如：空船前往" />
                </div>
                <div style="display: flex; gap: 4px; margin-top: 4px">
                  <PrunButton dark @click="cancelTripForm">取消</PrunButton>
                  <PrunButton primary :disabled="!canSubmitTrip" @click="handleCreateTrip(route.id)"
                    >发布</PrunButton
                  >
                </div>
              </div>
              <PrunButton
                v-else
                dark
                style="margin-top: 4px; font-size: 11px; width: 100%"
                @click="
                  startTripCreate(
                    route.id,
                    route.shipRegistrations.length > 0
                      ? getShipStatus(route.shipRegistrations[0])
                      : undefined,
                  )
                ">
                + 发布航班
              </PrunButton>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
