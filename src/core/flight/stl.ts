interface StlPerformance {
  acceleration: number;
  accelerationMax: number;
  operatingEmptyMass: number;
  ftlFuelMaterial: { weight: number };
}

interface StlDeparture {
  payload: number;
  stlFuel: number;
  ftlFuel: number;
  condition: number;
}

interface StlSurfacePhase {
  seconds: number;
  fuel: number;
}

interface SameSystemStlFlightInput {
  departureTimeMs: number;
  departureFuel: number;
  tier: number;
  minimumTransferFuel: number;
  takeoff: StlSurfacePhase;
  landing: StlSurfacePhase;
}

// 1 u STL 燃料的质量（t）。飞船总质量 = 空重 + 载重 + 燃料质量，见 stlAcceleration。
export const stlFuelMassPerUnit = 0.06;

export function flightConditionMultiplier(condition: number) {
  return Math.min(1, condition + 0.2);
}

export function stlAcceleration(performance: StlPerformance, departure: StlDeparture) {
  const { acceleration, accelerationMax, operatingEmptyMass, ftlFuelMaterial } = performance;
  const { payload, stlFuel, ftlFuel, condition } = departure;
  const mass =
    operatingEmptyMass + payload + stlFuelMassPerUnit * stlFuel + ftlFuelMaterial.weight * ftlFuel;
  return (
    Math.min(accelerationMax, (acceleration * operatingEmptyMass) / mass) *
    flightConditionMultiplier(condition)
  );
}

export function stlMinimumTransferFuel(
  targetOrbitSpeedKmS: number,
  acceleration: number,
  flow: number,
) {
  return Math.ceil((1.5 * targetOrbitSpeedKmS * flow) / (0.03 * acceleration));
}

// STL 余油在出发/到站转移段之间的分配（游戏实测规律，见
// docs/spec/26-11-14-flight-formula-remeasurement.md）。抽成导出函数是为了让回归脚本
// 直接调用生产实现，而不是各自复刻公式后走样。
export function departureTransferFuel(
  stlFuel: number,
  surfaceFuel: number,
  targetMinimumFuel: number,
  tier: number,
) {
  return Math.floor(((stlFuel - surfaceFuel - targetMinimumFuel + 2) * tier) / 2 + 1 + 1e-10);
}

export function approachTransferFuel(
  stlFuel: number,
  surfaceFuel: number,
  tier: number,
  circularMinimumFuel: number,
) {
  return Math.floor(
    ((stlFuel - surfaceFuel) * tier) / 2 + (1 - tier) * circularMinimumFuel + 1e-10,
  );
}

// 同星系单段转移：在「最小转移燃料」与「余油全给」之间按档位线性插值。
export function allocateTransferFuel(minimumFuel: number, tier: number, availableFuel: number) {
  return Math.floor(minimumFuel * (1 - tier) + availableFuel * tier + 1e-10);
}

export function stlTransferSeconds(
  distanceKm: number,
  fuel: number,
  acceleration: number,
  flow: number,
) {
  return Math.floor(stlTransferDuration(distanceKm, fuel, acceleration, flow));
}

export function stlTransferDuration(
  distanceKm: number,
  fuel: number,
  acceleration: number,
  flow: number,
) {
  const burn = Math.min((0.03 * fuel) / flow, Math.sqrt(distanceKm / acceleration));
  return distanceKm / (acceleration * burn) + burn;
}

export function stlSaturationFuel(distanceKm: number, acceleration: number, flow: number) {
  return Math.ceil((flow / 0.03) * Math.sqrt(distanceKm / acceleration));
}

export function resolveStlTransferTime(
  lengthAt: (elapsedSeconds: number) => number,
  startMs: number,
  fuel: number,
  acceleration: number,
  flow: number,
) {
  const estimateAt = (elapsedSeconds: number) => {
    const length = lengthAt(elapsedSeconds);
    return { length, seconds: stlTransferSeconds(length, fuel, acceleration, flow) };
  };
  let time = 0;
  for (let i = 0; i < 20; i++) {
    const estimate = estimateAt(time);
    if (Math.abs(estimate.seconds - time) <= 1) {
      return estimate;
    }
    time = estimate.seconds;
  }

  // Iteration can oscillate as the target moves, so bracket the arrival-time residual.
  let low = 0;
  let high = Math.max(1, time);
  const validArrival = (seconds: number) =>
    Math.abs(startMs + seconds * 1000) <= Number.MAX_SAFE_INTEGER;
  while (validArrival(high) && estimateAt(high).seconds > high) {
    high *= 2;
  }
  if (!validArrival(high)) {
    throw new Error('转移航程与到达时间未能收敛');
  }
  while (low <= high) {
    const trial = low + Math.floor((high - low) / 2);
    const estimate = estimateAt(trial);
    const residual = estimate.seconds - trial;
    if (Math.abs(residual) <= 1) {
      return estimate;
    }
    if (residual > 0) {
      low = trial + 1;
    } else {
      high = trial - 1;
    }
  }

  // The integer residual can skip over zero. Solve the continuous bracket before rounding.
  let earlier = high;
  let later = low;
  for (let i = 0; i < 20; i++) {
    const trial = (earlier + later) / 2;
    if (stlTransferDuration(lengthAt(trial), fuel, acceleration, flow) > trial) {
      earlier = trial;
    } else {
      later = trial;
    }
  }
  const arrival = (earlier + later) / 2;
  return { length: lengthAt(arrival), seconds: Math.floor(arrival) };
}

export function stlSurfaceFlight(distanceKm: number, acceleration: number, flow: number) {
  const seconds = Math.ceil(2 * Math.sqrt((500 * distanceKm) / acceleration));
  return { seconds, fuel: stlSurfaceFuel(seconds, flow) };
}

export function stlSurfaceFuel(seconds: number, flow: number) {
  // Multiplication order preserves the measured floating-point boundary before rounding.
  return Math.ceil((seconds * flow * 0.225) / 0.03);
}

const surfacePressureExponent = Math.log10(2);

export function stlTakeoffDistanceRatio(pressure: number) {
  return 0.15 + 0.45 * pressure ** surfacePressureExponent;
}

export function stlLandingDistanceKm(altitudeKm: number, pressure: number) {
  const multiplier = Math.min(7, 1 + 3 * pressure ** -surfacePressureExponent);
  return altitudeKm * multiplier;
}

export function missionParkingAltitudeRatio(missionId: string) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(missionId)) {
    throw new Error('Invalid flight mission UUID');
  }
  const hex = missionId.replaceAll('-', '');
  // The simulator starts java.util.Random from UUID.hashCode() for each parking orbit.
  const hash =
    Number.parseInt(hex.slice(0, 8), 16) ^
    Number.parseInt(hex.slice(8, 16), 16) ^
    Number.parseInt(hex.slice(16, 24), 16) ^
    Number.parseInt(hex.slice(24, 32), 16);
  const multiplier = BigInt(25214903917);
  const mask = BigInt(2 ** 48 - 1);
  const advance = (state: bigint) => (state * multiplier + BigInt(11)) & mask;
  const first = advance((BigInt(hash) ^ multiplier) & mask);
  const second = advance(first);
  const uniform = (Number(first >> BigInt(22)) * 2 ** 27 + Number(second >> BigInt(21))) / 2 ** 53;
  return 0.13 + 0.04 * uniform;
}

export function stlMissionLandingFlight(
  radiusKm: number,
  pressure: number,
  missionId: string,
  acceleration: number,
  flow: number,
) {
  const altitudeKm = missionParkingAltitudeRatio(missionId) * radiusKm;
  return stlSurfaceFlight(stlLandingDistanceKm(altitudeKm, pressure), acceleration, flow);
}

export function predictSameSystemStlFlight(
  input: SameSystemStlFlightInput,
  solveTransfer: (startMs: number, fuel: number) => { length: number; seconds: number },
) {
  const { departureTimeMs, departureFuel, tier, minimumTransferFuel, takeoff, landing } = input;
  const availableFuel = departureFuel - takeoff.fuel - landing.fuel;
  const transferFuel = allocateTransferFuel(minimumTransferFuel, tier, availableFuel);
  if (!(transferFuel > 0)) {
    throw new Error('STL transfer requires positive fuel');
  }
  const transfer = solveTransfer(departureTimeMs + takeoff.seconds * 1000, transferFuel);
  return {
    seconds: takeoff.seconds + transfer.seconds + landing.seconds,
    stlFuel: takeoff.fuel + transferFuel + landing.fuel,
    ftlFuel: 0,
    transfer: { ...transfer, fuel: transferFuel },
  };
}
