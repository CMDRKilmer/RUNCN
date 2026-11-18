interface GatewayTransfer {
  seconds: number;
  length: number;
}

interface GatewayStationFlightInput {
  departureTimeMs: number;
  jumpMillis: readonly number[];
  departureTransfer: (atMs: number, fuel: number) => GatewayTransfer;
  arrivalTransfer: (atMs: number, fuel: number) => GatewayTransfer;
}

export function stationGatewayFuelBudget(
  departureFuel: number,
  fixedFuel: number,
  firstMinimumFuel: number,
  lastMinimumFuel: number,
  tier: number,
  // 实际需要的 STL 转移段数（默认 2 = 出发端 + 到达端）。
  // 网关母星就是起终点天体时该端不需要转移，传 1 或 0：那一段的最小油量与余量份额都归零。
  transferCount = 2,
): [number, number] {
  // 4 u 是两侧转移段的松量（推导见 docs/spec/26-11-14-flight-formula-remeasurement.md:83）：
  // 先扣掉两侧最小转移油再分档位份额，留这点余量避免取整后某端油量归零。
  const freeFuel = departureFuel - fixedFuel - firstMinimumFuel - lastMinimumFuel - 4;
  const extra = (Math.max(0, freeFuel) * tier) / Math.max(1, transferCount);
  const first = firstMinimumFuel > 0 ? Math.floor(firstMinimumFuel + extra + 1e-10) : 0;
  const last = lastMinimumFuel > 0 ? Math.round(lastMinimumFuel + extra) : 0;
  return [first, last];
}

export function stationGatewayTiming(input: GatewayStationFlightInput) {
  const bridgeCount = input.jumpMillis.length + 1;
  const fixedMillis = input.jumpMillis.reduce(
    (sum, jump) => sum + jump,
    (input.jumpMillis.length * 1200 + bridgeCount * 10) * 1000,
  );
  const fixedFuel = input.jumpMillis.length * 10 + bridgeCount * 15;

  const estimate = (firstFuel: number, lastFuel: number) => {
    if (!(firstFuel > 0 && lastFuel > 0)) {
      throw new RangeError('网关空间站的转移段需要正的燃料预算');
    }
    const first = input.departureTransfer(input.departureTimeMs, firstFuel);
    const arrivalAtMs = input.departureTimeMs + first.seconds * 1000 + fixedMillis;
    const last = input.arrivalTransfer(arrivalAtMs, lastFuel);
    return {
      seconds: first.seconds + last.seconds + fixedMillis / 1000,
      stlFuel: firstFuel + lastFuel + fixedFuel,
      ftlFuel: 0,
      transfers: [
        { seconds: first.seconds, fuel: firstFuel, km: first.length },
        { seconds: last.seconds, fuel: lastFuel, km: last.length },
      ],
    };
  };

  return { bridgeCount, fixedFuel, estimate };
}
