import assert from 'node:assert/strict';
import { findFlightRoute } from '../../src/core/flight/route.ts';
import { gatewayEdges } from './gateway-pilot.mjs';

export function selectFlightRoute(input, from, to, preferences, shipVolume) {
  assert(['LEAST_JUMPS', 'SHORTEST_FTL'].includes(preferences.ftlPreference));
  const gates = preferences.useGateways ? gatewayEdges(input, shipVolume) : [];
  const gatewayLegs = gates.map(gate => ({
    from: gate.a.systemId,
    to: gate.b.systemId,
    gate,
  }));
  return findFlightRoute(input.stars, gatewayLegs, from, to, preferences.ftlPreference);
}
