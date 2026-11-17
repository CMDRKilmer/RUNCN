interface FlightState {
  atMs: number;
  stlFuel: number;
  ftlFuel: number;
}

interface FlightUse {
  seconds: number;
  stlFuel: number;
  ftlFuel: number;
}

export function advanceFlightState(departure: FlightState, flight: FlightUse) {
  const arrivalAtMs = departure.atMs + flight.seconds * 1000;
  if (
    !Number.isFinite(departure.atMs) ||
    !Number.isFinite(arrivalAtMs) ||
    ![departure.stlFuel, departure.ftlFuel, flight.seconds, flight.stlFuel, flight.ftlFuel].every(
      x => Number.isFinite(x) && x >= 0,
    )
  ) {
    throw new RangeError('Flight time and fuel must be finite and fuel cannot be negative');
  }
  const stlFuel = departure.stlFuel - flight.stlFuel;
  const ftlFuel = departure.ftlFuel - flight.ftlFuel;
  if (stlFuel < 0 || ftlFuel < 0) {
    return {
      ok: false as const,
      shortfall: { stlFuel: Math.max(0, -stlFuel), ftlFuel: Math.max(0, -ftlFuel) },
    };
  }
  return {
    ok: true as const,
    arrival: { atMs: arrivalAtMs, stlFuel, ftlFuel },
  };
}

export function predictNoRefuelItinerary<Leg, Prediction extends FlightUse>(
  initial: FlightState,
  legs: readonly { input: Leg; waitBeforeMs?: number }[],
  predict: (leg: Leg, departure: Readonly<FlightState>, index: number) => Prediction,
) {
  const steps: { departure: FlightState; predicted: Prediction; arrival: FlightState }[] = [];
  let arrival = initial;
  for (const [index, leg] of legs.entries()) {
    const wait = leg.waitBeforeMs ?? 0;
    const atMs = arrival.atMs + wait;
    if (!Number.isFinite(wait) || wait < 0 || !Number.isFinite(atMs)) {
      throw new RangeError('Flight wait and departure time must be finite, with nonnegative wait');
    }
    const departure = { ...arrival, atMs };
    const predicted = predict(leg.input, departure, index);
    const state = advanceFlightState(departure, predicted);
    if (!state.ok) {
      return { ok: false as const, steps, index, shortfall: state.shortfall };
    }
    arrival = state.arrival;
    steps.push({ departure, predicted, arrival });
  }
  return { ok: true as const, steps, arrival };
}
