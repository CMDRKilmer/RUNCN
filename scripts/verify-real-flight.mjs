// Usage: node --experimental-strip-types scripts/verify-real-flight.mjs
// Replays the recorded single-leg real-ship flight (Dwarf-PLUTO / BP-XZWK-1228, HRT → VH-192c,
// one natural jump, landing on) through the production STL/FTL laws plus the bundled FIO orbit,
// star-mass and planet-environment assets. Locks the acceleration law, the STL fuel budgets, the
// mission-UUID parking altitude, the landing distance curve, transfer kinematics and the natural
// jump fuel against data collected outside the test-flight collector.
// Limitations: one leg only — the logs hold no second departure and no FLIGHT_ENDED record, so
// this covers neither no-refuel continuity nor SFC/FLEET write-back. The natural-jump duration is
// not predicted: the blueprint FTL max speed, emitter charge and overcharge times were never
// recorded. Both STL transfer durations use the distances the server recorded in its own segment
// records, not recomputed ephemerides (the preflight star graph was not exported).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  approachTransferFuel,
  departureTransferFuel,
  flightConditionMultiplier,
  missionParkingAltitudeRatio,
  stlAcceleration,
  stlLandingDistanceKm,
  stlMinimumTransferFuel,
  stlMissionLandingFlight,
  stlSaturationFuel,
  stlTransferSeconds,
} from '../src/core/flight/stl.ts';
import { naturalJumpFuel } from '../src/core/flight/ftl.ts';
import {
  gameCircularOrbitSpeedKmS,
  gameOrbitalSpeedKmS,
} from '../src/infrastructure/fio/orbit-position.ts';

const read = path =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\uFEFF/, ''));

const fixture = read('./fixtures/real-flight-dwarf-pluto.json');
const planets = read('../public/json/planets-orbit.json');
const starMasses = read('../public/json/star-masses.json');
const environments = read('../public/json/planet-env.json');

// Game-wide orbital motion constants, identical to the defaults in src/infrastructure/fio/orbit.
const MOTION_FACTOR = 20;
const SIMULATION_INTERVAL_S = 86400;
// The recorded game clock uses 0.06 t per STL fuel unit and the blueprint stores 0.05 t per FTL.
const STL_FUEL_UNIT_WEIGHT = 0.06;
const FTL_FUEL_UNIT_WEIGHT = 0.05;

let checks = 0;
let failures = 0;

function equals(name, actual, expected, tolerance = 0) {
  checks++;
  if (!(Math.abs(actual - expected) <= tolerance)) {
    failures++;
    console.log(`FAIL ${name} expected=${expected} actual=${actual} tolerance=${tolerance}`);
  }
}

// Acceptance tolerances from the re-measurement spec: 5% or 5 s for time, 1 u for fuel.
const timeTolerance = seconds => Math.max(seconds * 0.05, 5);

const { ship, request, destinationBody, departure, flown, superseded, inFlightSnapshot } = fixture;
const performance = {
  acceleration: ship.thrust / ship.operatingEmptyMass,
  // The recorded acceleration equals thrust / mass at the loaded mass, so no cap was binding.
  accelerationMax: Number.POSITIVE_INFINITY,
  operatingEmptyMass: ship.operatingEmptyMass,
  ftlFuelMaterial: { weight: FTL_FUEL_UNIT_WEIGHT },
};
const flow = ship.stlFuelFlowRate;
const tier = request.fuelUsageFactor;
const segment = (plan, type) => plan.segments.find(x => x.type === type);
const seconds = x => (x.arrivalMs - x.departureMs) / 1000;

const planet = planets.find(x => x.n === destinationBody.naturalId);
assert(planet, '缺少目的行星的轨道数据');
const environment = environments[destinationBody.naturalId.toUpperCase()];
assert(environment, '缺少目的行星的环境数据');
const star = starMasses.find(x => x.n === destinationBody.systemNaturalId);
assert(star, '缺少目的星系的恒星质量');

const orbit = {
  semiMajorAxis: planet.a,
  eccentricity: planet.e,
  inclination: planet.i,
  rightAscension: planet.o,
  periapsis: planet.p,
  mass: planet.m,
};
const centralMass = star.m + orbit.mass;

// 1. Departure state: cargo plus both full tanks, minus the fuel already debited at departure.
const plannedMass =
  ship.operatingEmptyMass +
  departure.payload +
  STL_FUEL_UNIT_WEIGHT * (departure.stlFuel - segment(flown, 'DEPARTURE').stlFuelConsumption) +
  FTL_FUEL_UNIT_WEIGHT * departure.ftlFuel;
equals('planned departure mass', plannedMass, inFlightSnapshot.mass, 0.01);

// 2. Acceleration law: thrust over the loaded mass, with the condition multiplier capped at 1.
equals('condition multiplier', flightConditionMultiplier(ship.condition), 1, 1e-12);
equals('acceleration', ship.thrust / plannedMass, inFlightSnapshot.acceleration, 1e-6);

const acceleration = stlAcceleration(performance, {
  payload: departure.payload,
  stlFuel: departure.stlFuel,
  ftlFuel: departure.ftlFuel,
  condition: ship.condition,
});

// 3. Landing: parking altitude from the mission UUID, then the pressure-scaled descent.
const landingRatio = missionParkingAltitudeRatio(request.missionId);
const landingDistance = stlLandingDistanceKm(environment.r * landingRatio, environment.p);
equals('landing distance', landingDistance, segment(flown, 'LANDING').stlDistance, 1);
const landing = stlMissionLandingFlight(
  environment.r,
  environment.p,
  request.missionId,
  acceleration,
  flow,
);
equals('landing seconds', landing.seconds, seconds(segment(flown, 'LANDING')));
equals('landing fuel', landing.fuel, segment(flown, 'LANDING').stlFuelConsumption);
const surfaceFuel = landing.fuel;

// 4. Orbital budgets: station departure reserves the target's transfer fuel, the approach
// reserves the circular-orbit minimum.
const orbitalSpeed = gameOrbitalSpeedKmS(
  orbit,
  centralMass,
  departure.atMs,
  MOTION_FACTOR,
  SIMULATION_INTERVAL_S,
);
const circularSpeed = gameCircularOrbitSpeedKmS(
  orbit,
  centralMass,
  MOTION_FACTOR,
  SIMULATION_INTERVAL_S,
);
const targetMinimum = stlMinimumTransferFuel(orbitalSpeed, acceleration, flow);
const circularMinimum = stlMinimumTransferFuel(circularSpeed, acceleration, flow);
// 分配规律直接用生产实现（src/core/flight/stl.ts），脚本不再复刻这两条公式。
const departureFuel = departureTransferFuel(departure.stlFuel, surfaceFuel, targetMinimum, tier);
const approachFuel = approachTransferFuel(departure.stlFuel, surfaceFuel, tier, circularMinimum);
equals('departure fuel', departureFuel, segment(flown, 'DEPARTURE').stlFuelConsumption);
equals('approach fuel', approachFuel, segment(flown, 'APPROACH').stlFuelConsumption);
equals(
  'departure fuel is below saturation',
  Math.min(
    departureFuel,
    stlSaturationFuel(segment(flown, 'DEPARTURE').stlDistance, acceleration, flow),
  ),
  departureFuel,
);

// 5. Transfer kinematics from the distances the server recorded for its own segments.
const departureSeconds = stlTransferSeconds(
  segment(flown, 'DEPARTURE').stlDistance,
  departureFuel,
  acceleration,
  flow,
);
equals(
  'departure seconds',
  departureSeconds,
  seconds(segment(flown, 'DEPARTURE')),
  timeTolerance(seconds(segment(flown, 'DEPARTURE'))),
);
const approachSeconds = stlTransferSeconds(
  segment(flown, 'APPROACH').stlDistance,
  approachFuel,
  acceleration,
  flow,
);
equals(
  'approach seconds',
  approachSeconds,
  seconds(segment(flown, 'APPROACH')),
  timeTolerance(seconds(segment(flown, 'APPROACH'))),
);

// 6. Natural jump fuel and whole-flight totals (the jump duration itself is not predicted).
const jumpFuel = naturalJumpFuel(flown.ftlDistance, ship.reactorPower, request.reactorUsageFactor);
equals('natural jump fuel', jumpFuel, flown.ftlFuelConsumption);
const stlFuel = departureFuel + approachFuel + landing.fuel;
equals('whole-flight STL fuel', stlFuel, flown.stlFuelConsumption);
const predictedSeconds =
  departureSeconds + seconds(segment(flown, 'JUMP')) + approachSeconds + landing.seconds;
equals(
  'whole-flight seconds',
  predictedSeconds,
  flown.etaMs / 1000,
  timeTolerance(flown.etaMs / 1000),
);

// 7. The second SHIP_FLIGHT_MISSION for the same mission id was recomputed after CREATE_FLIGHT
// debited the departure fuel, which also raised the acceleration of the lighter ship.
const reservedStl = departure.stlFuel - segment(flown, 'DEPARTURE').stlFuelConsumption;
const reservedAcceleration = stlAcceleration(performance, {
  payload: departure.payload,
  stlFuel: reservedStl,
  ftlFuel: departure.ftlFuel,
  condition: ship.condition,
});
const reservedBase = ((reservedStl - surfaceFuel) * tier) / 2;
const reservedMinimum = stlMinimumTransferFuel(orbitalSpeed, reservedAcceleration, flow);
const reservedCircular = stlMinimumTransferFuel(circularSpeed, reservedAcceleration, flow);
equals(
  'reserved departure fuel',
  Math.floor(((reservedStl - surfaceFuel - reservedMinimum + 2) * tier) / 2 + 1 + 1e-10),
  segment(superseded, 'DEPARTURE').stlFuelConsumption,
);
equals(
  'reserved approach fuel',
  Math.floor(reservedBase + (1 - tier) * reservedCircular + 1e-10),
  segment(superseded, 'APPROACH').stlFuelConsumption,
);
equals(
  'reserved departure seconds',
  stlTransferSeconds(
    segment(superseded, 'DEPARTURE').stlDistance,
    segment(superseded, 'DEPARTURE').stlFuelConsumption,
    reservedAcceleration,
    flow,
  ),
  seconds(segment(superseded, 'DEPARTURE')),
);
equals(
  'reserved approach seconds',
  stlTransferSeconds(
    segment(superseded, 'APPROACH').stlDistance,
    segment(superseded, 'APPROACH').stlFuelConsumption,
    reservedAcceleration,
    flow,
  ),
  seconds(segment(superseded, 'APPROACH')),
);

console.log(
  `real flight AVI-06JVV ${fixture.recordedLocal}: ${flown.stlFuelConsumption} u STL, ` +
    `${flown.ftlFuelConsumption} u FTL, ${flown.etaMs / 1000} s; predicted ` +
    `${stlFuel} u STL and ${predictedSeconds} s`,
);
console.log(failures === 0 ? `PASS ${checks}/${checks}` : `FAIL ${checks - failures}/${checks}`);
process.exitCode = failures === 0 ? 0 : 1;
