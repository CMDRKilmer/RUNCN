interface FlightRouteStar {
  naturalId: string;
  systemId: string;
  position: { x: number; y: number; z: number };
  connections?: readonly string[];
}

interface FlightRouteLeg<Gateway> {
  from: string;
  to: string;
  gate?: Gateway;
}

interface FlightRouteCandidate<Gateway> {
  id: string;
  hops: number;
  gatewayHops: number;
  distance: number;
  legs: FlightRouteLeg<Gateway>[];
}

export function findFlightRoute<Gateway>(
  stars: readonly FlightRouteStar[],
  gatewayLegs: readonly (FlightRouteLeg<Gateway> & { gate: Gateway })[],
  from: string,
  to: string,
  preference: 'LEAST_JUMPS' | 'SHORTEST_FTL',
) {
  const compare = (a: FlightRouteCandidate<Gateway>, b: FlightRouteCandidate<Gateway>) => {
    if (preference === 'LEAST_JUMPS') {
      if (a.hops !== b.hops) {
        return a.hops - b.hops;
      }
      if (a.gatewayHops !== b.gatewayHops) {
        return a.gatewayHops - b.gatewayHops;
      }
    }
    return a.distance - b.distance;
  };
  const starsByName = new Map(stars.map(x => [x.naturalId, x]));
  const namesById = new Map(stars.map(x => [x.systemId, x.naturalId]));
  const gatewaysByOrigin = new Map<string, FlightRouteLeg<Gateway>[]>();
  for (const leg of gatewayLegs) {
    const group = gatewaysByOrigin.get(leg.from);
    if (group === undefined) {
      gatewaysByOrigin.set(leg.from, [leg]);
    } else {
      group.push(leg);
    }
  }

  const departure: FlightRouteCandidate<Gateway> = {
    id: from,
    hops: 0,
    gatewayHops: 0,
    distance: 0,
    legs: [],
  };
  const queue = [departure];
  const best = new Map([[from, departure]]);
  while (queue.length > 0) {
    queue.sort(compare);
    const current = queue.shift()!;
    const { id, legs } = current;
    if (current !== best.get(id)) {
      continue;
    }
    if (id === to) {
      return legs;
    }
    const star = starsByName.get(id);
    if (star === undefined) {
      continue;
    }
    const natural: FlightRouteLeg<Gateway>[] = [];
    for (const systemId of star.connections ?? []) {
      const name = namesById.get(systemId);
      if (name !== undefined) {
        natural.push({ from: id, to: name });
      }
    }
    for (const leg of [...natural, ...(gatewaysByOrigin.get(id) ?? [])]) {
      const next = starsByName.get(leg.to);
      if (next === undefined) {
        continue;
      }
      const a = star.position;
      const b = next.position;
      const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / 12;
      if (!Number.isFinite(distance)) {
        throw new RangeError('星图缺少有效跃迁距离');
      }
      const candidate: FlightRouteCandidate<Gateway> = {
        id: leg.to,
        hops: current.hops + 1,
        gatewayHops: current.gatewayHops + Number(leg.gate !== undefined),
        distance: current.distance + distance,
        legs: [...legs, leg],
      };
      const earlier = best.get(leg.to);
      if (earlier === undefined || compare(candidate, earlier) < 0) {
        best.set(leg.to, candidate);
        queue.push(candidate);
      }
    }
  }
  return undefined;
}
