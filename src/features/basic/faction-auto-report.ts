import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import { userData } from '@src/store/user-data';
import {
  isAuthenticated,
  aggregateMyProduction,
  reportProduction,
  reportShipStatuses,
} from '@src/features/XIT/FACTION/use-faction-api';
import type { ShipStatusReport } from '@src/features/XIT/FACTION/types';

function init() {
  // --- Production auto-report (daily) ---
  let reported = false;
  watchEffect(() => {
    if (reported) return;
    if (!sitesStore.fetched.value) return;
    if (!isAuthenticated()) return;

    const today = new Date().toISOString().slice(0, 10);
    if (userData.lastAutoProductionDate === today) return;

    reported = true;

    aggregateMyProduction()
      .then(items => {
        return reportProduction(items).then(() => {
          userData.lastAutoProductionDate = today;
        });
      })
      .catch(() => {
        reported = false;
      });
  });

  // --- Ship status auto-report (once on game open) ---
  let shipReported = false;
  watchEffect(() => {
    if (shipReported) return;
    if (!shipsStore.fetched.value) return;
    if (!flightsStore.fetched.value) return;
    if (!storagesStore.fetched.value) return;
    if (!isAuthenticated()) return;

    const ships = shipsStore.all.value ?? [];
    const companyName = companyStore.value?.name ?? '';
    if (!companyName || ships.length === 0) return;

    shipReported = true;

    const reports: Omit<ShipStatusReport, 'reportedAt'>[] = ships.map(ship => {
      const flight = ship.flightId ? flightsStore.getById(ship.flightId) : undefined;
      const cargoStores = storagesStore.getByAddressableId(ship.id);
      const cargoStore = cargoStores?.find(s => s.type === 'SHIP_STORE');
      return {
        companyName,
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

    reportShipStatuses(reports).catch(() => {
      shipReported = false;
    });
  });
}

features.add(import.meta.url, init, 'Auto-reports faction production and ship status.');
