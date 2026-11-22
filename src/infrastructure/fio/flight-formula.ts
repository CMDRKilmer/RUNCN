import {
  approachTransferFuel,
  departureTransferFuel,
  flightConditionMultiplier,
  missionParkingAltitudeRatio,
  predictSameSystemStlFlight,
  resolveStlTransferTime,
  stlAcceleration,
  stlLandingDistanceKm,
  stlMinimumTransferFuel,
  stlSaturationFuel,
  stlSurfaceFlight,
  stlTakeoffDistanceRatio,
  stlTransferSeconds,
} from '@src/core/flight/stl';
import { ellipseBetween } from '@src/core/flight/transfer-ellipse';
import { naturalChargeSeconds, naturalJumpFuel, naturalJumpSpeed } from '@src/core/flight/ftl';
import { findFlightRoute } from '@src/core/flight/route';
import { stationGatewayFuelBudget } from '@src/core/flight/gateway';
import {
  gameCircularOrbitSpeedKmS,
  gameOrbitalSpeedKmS,
  predictWithGameModel,
  type PlanetOrbit,
} from './orbit-position';

export interface FlightBlueprint {
  performance: {
    acceleration: number;
    accelerationMax: number;
    operatingEmptyMass: number;
    ftlFuelMaterial: { weight: number };
    stlFuelCapacity: number;
    ftlFuelCapacity: number;
    storeCapacityWeight: number;
    totalVolume: number;
    ftlMaxSpeed: number;
    minReactorUsage: number;
    emitterChargeTime: number;
    maxOverchargeTime: number;
  };
  selections: {
    type: string;
    option: string;
    amount: number;
    modifiers: { type: string; value: number }[];
  }[];
}

export interface FlightRequest {
  origin: string;
  destination: string;
  missionId?: string;
  landing: boolean;
  payload: number;
  condition: number;
  stlFuel: number;
  ftlFuel: number;
  fuelUsageFactor: number;
  reactorUsageFactor: number;
  preferences: { useGateways: boolean; ftlPreference: 'LEAST_JUMPS' | 'SHORTEST_FTL' };
}

export interface FlightEndpoint {
  naturalId?: string;
  systemId?: string;
  orbit?: PlanetOrbit;
  parentMassKg?: number;
}

interface Gateway {
  naturalId: string;
  systemId: string;
  planetId?: string;
  operational: boolean;
  maxShipVolume?: number;
}

export interface FlightInputs {
  orbit: { motionFactor: number; simulationIntervalS: number; endpoints: FlightEndpoint[] };
  environment: { env?: { radiusKm: number; pressure?: number } }[];
  stars: {
    naturalId: string;
    systemId: string;
    position: { x: number; y: number; z: number };
    connections: string[];
  }[];
  gateways: Gateway[];
  gatewayConnections: { fromGatewayId?: string; toGatewayId?: string }[];
  gatewayEndpoints: Record<string, FlightEndpoint>;
}

type Vector = { x: number; y: number; z: number };
export interface FormulaSegment {
  type:
    | 'TAKE_OFF'
    | 'LANDING'
    | 'TRANSIT'
    | 'DEPARTURE'
    | 'APPROACH'
    | 'CHARGE'
    | 'JUMP'
    | 'LOCK'
    | 'JUMP_GATEWAY'
    | 'DECAY';
  seconds: number;
  stlFuel: number;
  ftlFuel: number;
}

// 「输入不全」专用错误：只有这类错误才算 inputIncomplete。
// 调用方（formula-plan）据此区分「缺数据」与「代码炸了」——编程错误若也伪装成缺输入，
// SFC 会静默跳过滑块、FLEET 会标缺，真正的 bug 就永远看不见。
export class FlightInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlightInputError';
  }
}

export class FlightFuelError extends FlightInputError {}

function requireInput(ok: boolean, message: string): asserts ok {
  if (!ok) {
    throw new FlightInputError(message);
  }
}

function requireFuel(ok: boolean, message: string) {
  if (!ok) {
    throw new FlightFuelError(message);
  }
}

// 同一个天体的两次快照（起点/终点 vs 网关母星）——网关母星与端点重合时不需要 STL 转移。
function sameBody(a: FlightEndpoint | undefined, b: FlightEndpoint | undefined) {
  return a?.naturalId !== undefined && a.naturalId === b?.naturalId;
}

function elements(endpoint: FlightEndpoint) {
  const { orbit, parentMassKg } = endpoint;
  requireInput(
    orbit !== undefined && parentMassKg !== undefined && parentMassKg > 0,
    `缺少 ${endpoint.naturalId ?? '天体'} 的轨道或恒星质量`,
  );
  requireInput(
    Object.values(orbit).every(Number.isFinite) &&
      orbit.semiMajorAxis > 0 &&
      orbit.eccentricity >= 0 &&
      orbit.eccentricity < 1,
    '轨道参数无效',
  );
  return { orbit, mass: parentMassKg + orbit.mass };
}

export function selectFormulaRoute(q: FlightRequest, bp: FlightBlueprint, input: FlightInputs) {
  const [from, to] = input.orbit.endpoints;
  requireInput(from?.systemId !== undefined && to?.systemId !== undefined, '缺少起终点星系');
  const route = findFlightRoute(
    input.stars,
    gatewayLegsFor(q, bp, input),
    from.systemId,
    to.systemId,
    q.preferences.ftlPreference,
  );
  requireInput(route !== undefined, '星图中没有可达航线，请刷新原生星图或检查网关连接');
  return route;
}

function gatewayLegsFor(q: FlightRequest, bp: FlightBlueprint, input: FlightInputs) {
  if (!q.preferences.useGateways) {
    return [];
  }
  const gates = new Map(input.gateways.filter(x => x.operational).map(x => [x.naturalId, x]));
  return input.gatewayConnections.flatMap(x => {
    const a = gates.get(x.fromGatewayId ?? '');
    const b = gates.get(x.toGatewayId ?? '');
    if (a === undefined || b === undefined) {
      return [];
    }
    return [
      { a, b },
      { a: b, b: a },
    ]
      .filter(x => bp.performance.totalVolume <= (x.a.maxShipVolume ?? 6000))
      .map(gate => ({ from: gate.a.systemId, to: gate.b.systemId, gate }));
  });
}

// 诊断用：**不加**端点约束时，星图上是否存在含网关段的路线。
// 用于在「勾了网关却按自然跃迁算」时告诉玩家原因（缺数据 / 只有不支持的形状 / 不需要网关）。
export function gatewayRouteAvailable(q: FlightRequest, bp: FlightBlueprint, input: FlightInputs) {
  const [from, to] = input.orbit.endpoints;
  if (from?.systemId === undefined || to?.systemId === undefined) {
    return false;
  }
  try {
    const route = findFlightRoute(
      input.stars,
      gatewayLegsFor(q, bp, input),
      from.systemId,
      to.systemId,
      q.preferences.ftlPreference,
    );
    return route?.some(leg => leg.gate !== undefined) === true;
  } catch {
    // 纯诊断用，不能因为它把整次计算弄挂。
    return false;
  }
}

// Consumes preflight inputs only. A missing mission UUID uses the parking-altitude midpoint.
export function predictFormulaFlight(
  q: FlightRequest,
  bp: FlightBlueprint,
  input: FlightInputs,
  timeMs: number,
) {
  const p = bp.performance;
  requireInput(Number.isFinite(timeMs), '出发时间无效');
  requireInput(
    Number.isFinite(q.payload) &&
      q.payload >= 0 &&
      Number.isFinite(q.condition) &&
      q.condition >= 0 &&
      q.condition <= 1,
    '载重须非负，船况须在 0–1 之间',
  );
  requireInput(
    Number.isFinite(p.storeCapacityWeight) && q.payload <= p.storeCapacityWeight,
    '载重超过蓝图货舱容量',
  );
  requireInput(
    Number.isFinite(q.stlFuel) &&
      q.stlFuel >= 0 &&
      q.stlFuel <= p.stlFuelCapacity &&
      Number.isFinite(q.ftlFuel) &&
      q.ftlFuel >= 0 &&
      q.ftlFuel <= p.ftlFuelCapacity,
    '出发余油须在 0 与蓝图罐容量之间',
  );
  requireInput(
    Number.isFinite(q.fuelUsageFactor) && q.fuelUsageFactor >= 0.05 && q.fuelUsageFactor <= 1,
    'STL 档位须在 0.05–1 之间',
  );
  requireInput(
    p.ftlFuelMaterial?.weight >= 0 && p.operatingEmptyMass > 0,
    '蓝图缺少整备质量或 FTL 燃料重量',
  );
  const engine = bp.selections.find(x => x.type === 'STL_ENGINE' && x.amount > 0);
  const flow = engine?.modifiers.find(x => x.type === 'STL_USAGE')?.value;
  const a = stlAcceleration(p, q);
  requireInput(
    flow !== undefined && flow > 0 && Number.isFinite(a) && a > 0,
    '蓝图缺少有效 STL 流量或加速度',
  );
  const orbit = input.orbit;
  requireInput(
    orbit.endpoints.length === 2 && orbit.motionFactor > 0 && orbit.simulationIntervalS > 0,
    '缺少起终点轨道或世界时钟参数',
  );
  const [origin, destination] = orbit.endpoints;
  elements(origin);
  elements(destination);
  const kind = (address: string) => address.split('|')[1]?.split(',')[0];
  requireInput(
    ['PLA', 'STA'].includes(kind(q.origin)) && ['PLA', 'STA'].includes(kind(q.destination)),
    '请选择具体行星或空间站',
  );
  requireInput(q.origin !== q.destination, '起点和终点必须不同');
  const takesOff = kind(q.origin) === 'PLA';
  const lands = kind(q.destination) === 'PLA' && q.landing;
  const estimatedLanding = lands && !q.missionId;
  const surface = (takeoff: boolean) => {
    const env = input.environment[takeoff ? 0 : 1]?.env;
    requireInput(
      env !== undefined &&
        env.radiusKm > 0 &&
        env.pressure !== undefined &&
        Number.isFinite(env.pressure) &&
        env.pressure >= 0,
      '缺少起降行星半径或气压',
    );
    const ratio = !takeoff && q.missionId ? missionParkingAltitudeRatio(q.missionId) : 0.15;
    const distance = takeoff
      ? env.radiusKm * stlTakeoffDistanceRatio(env.pressure)
      : stlLandingDistanceKm(env.radiusKm * ratio, env.pressure);
    return stlSurfaceFlight(distance, a, flow);
  };
  const up = takesOff ? surface(true) : { seconds: 0, fuel: 0 };
  const down = lands ? surface(false) : { seconds: 0, fuel: 0 };
  const surfaceFuel = up.fuel + down.fuel;
  requireFuel(q.stlFuel >= surfaceFuel, `STL 余油不足以覆盖起降耗油（${surfaceFuel} u）`);
  const route = selectFormulaRoute(q, bp, input);
  const hasNatural = route.some(x => x.gate === undefined);
  let mixedNeedsBlindTest = false;
  const power = bp.selections
    .find(x => x.type === 'FTL_REACTOR' && x.amount > 0)
    ?.modifiers.find(x => x.type === 'FTL_POWER')?.value;
  if (hasNatural) {
    requireInput(
      power !== undefined &&
        power > 0 &&
        p.ftlMaxSpeed > 0 &&
        p.minReactorUsage >= 0 &&
        p.minReactorUsage < 1 &&
        p.emitterChargeTime >= 0 &&
        p.maxOverchargeTime >= 0,
      '蓝图缺少有效 FTL 性能',
    );
    requireInput(
      Number.isFinite(q.reactorUsageFactor) &&
        q.reactorUsageFactor >= p.minReactorUsage &&
        q.reactorUsageFactor <= 1,
      `反应堆档位须在 ${p.minReactorUsage}–1 之间`,
    );
  }
  const position = (endpoint: FlightEndpoint, at: number) => {
    const { orbit: el, mass } = elements(endpoint);
    return predictWithGameModel(el, mass, at, orbit.motionFactor, orbit.simulationIntervalS);
  };
  const minimum = (endpoint: FlightEndpoint, circular = false) => {
    const { orbit: el, mass } = elements(endpoint);
    const speed = circular
      ? gameCircularOrbitSpeedKmS(el, mass, orbit.motionFactor, orbit.simulationIntervalS)
      : gameOrbitalSpeedKmS(el, mass, timeMs, orbit.motionFactor, orbit.simulationIntervalS);
    return stlMinimumTransferFuel(speed, a, flow);
  };
  const fromPoint = (from: Vector, to: FlightEndpoint, at: number, fuel: number) => {
    requireFuel(fuel > 0, 'STL 余油不足以分配转移段');
    return resolveStlTransferTime(
      seconds => ellipseBetween(from, position(to, at + seconds * 1000)).length,
      at,
      fuel,
      a,
      flow,
    );
  };
  const transfer = (from: FlightEndpoint, to: FlightEndpoint, at: number, fuel: number) =>
    fromPoint(position(from, at), to, at, fuel);
  const segments: FormulaSegment[] = [];
  const totals = { seconds: 0, stlFuel: 0, ftlFuel: 0 };
  const append = (type: FormulaSegment['type'], seconds: number, stlFuel = 0, ftlFuel = 0) => {
    requireInput(
      [seconds, stlFuel, ftlFuel].every(x => Number.isFinite(x) && x >= 0),
      '公式无法计算此航线',
    );
    segments.push({ type, seconds, stlFuel, ftlFuel });
    totals.seconds += seconds;
    totals.stlFuel += stlFuel;
    totals.ftlFuel += ftlFuel;
  };
  const now = () => timeMs + totals.seconds * 1000;
  if (takesOff) {
    append('TAKE_OFF', up.seconds, up.fuel);
  }
  if (route.length === 0) {
    const sameSystem = predictSameSystemStlFlight(
      {
        departureTimeMs: timeMs,
        departureFuel: q.stlFuel,
        tier: q.fuelUsageFactor,
        minimumTransferFuel: minimum(destination),
        takeoff: up,
        landing: down,
      },
      (at, fuel) => transfer(origin, destination, at, fuel),
    );
    append('TRANSIT', sameSystem.transfer.seconds, sameSystem.transfer.fuel);
  } else {
    const blocks: {
      gateway: boolean;
      legs: typeof route;
      start?: FlightEndpoint;
      end?: FlightEndpoint;
    }[] = [];
    for (const leg of route) {
      const gateway = leg.gate !== undefined;
      if (blocks.at(-1)?.gateway !== gateway) {
        blocks.push({ gateway, legs: [] });
      }
      blocks.at(-1)!.legs.push(leg);
    }
    const gatewayFirst = blocks[0].gateway;
    const gatewayLast = blocks.at(-1)!.gateway;
    const mixed = blocks.length > 1;
    if (mixed) {
      const supportedBlocks =
        blocks.length === 2 || (blocks.length === 3 && !gatewayFirst && !gatewayLast);
      requireInput(
        supportedBlocks &&
          (gatewayFirst || takesOff) &&
          (gatewayLast || lands) &&
          engine?.option === 'STL_ENGINE_STANDARD',
        '此混合航线组合尚未验收',
      );
      mixedNeedsBlindTest = !gatewayFirst;
    }
    let fixedFuel = 0;
    for (const block of blocks.filter(x => x.gateway)) {
      const gates = block.legs.map(x => x.gate!);
      requireInput(
        gates
          .slice(1)
          .every((x, i) => x.a.planetId !== undefined && x.a.planetId === gates[i].b.planetId),
        '暂不支持跨行星网关接驳',
      );
      block.start = input.gatewayEndpoints[gates[0].a.naturalId];
      block.end = input.gatewayEndpoints[gates.at(-1)!.b.naturalId];
      requireInput(block.start !== undefined && block.end !== undefined, '缺少网关行星轨道');
      elements(block.start);
      elements(block.end);
      fixedFuel += gates.length * 10 + (gates.length + 1) * 15;
    }
    const tier = q.fuelUsageFactor;
    const base = ((q.stlFuel - surfaceFuel) * tier) / 2;
    const targetMinimum = minimum(destination);
    let departureFuel = departureTransferFuel(q.stlFuel, surfaceFuel, targetMinimum, tier);
    let approachFuel =
      kind(q.destination) === 'STA'
        ? Math.ceil(base + targetMinimum * (1 - 0.75 * tier)) - 1
        : approachTransferFuel(q.stlFuel, surfaceFuel, tier, minimum(destination, true));
    let firstFuel = 0;
    let lastFuel = 0;
    // 网关母星就是起点/终点天体时，该端不需要 STL 转移（原生 SFC 实测：
    // HRT → OF-375b 走 GTW-PGG-155 → GTW-MWD-607，网关绕着 OF-375b 本身，
    // 到达后直接 LANDING，没有到站转移段）。此时该端预算归零。
    const noFirstTransfer = gatewayFirst && sameBody(origin, blocks[0].start);
    const noLastTransfer = gatewayLast && sameBody(blocks.at(-1)!.end, destination);
    if (gatewayFirst && gatewayLast && !mixed) {
      [firstFuel, lastFuel] = stationGatewayFuelBudget(
        q.stlFuel,
        fixedFuel,
        noFirstTransfer ? 0 : minimum(blocks[0].start!),
        noLastTransfer ? 0 : targetMinimum,
        tier,
        Number(!noFirstTransfer) + Number(!noLastTransfer),
      );
    } else if (mixed) {
      const count =
        Number(gatewayFirst) + Number(gatewayLast) + 2 * blocks.filter(x => !x.gateway).length;
      const mixedBase = ((q.stlFuel - surfaceFuel - fixedFuel - 15) * tier) / count;
      departureFuel = Math.floor(mixedBase + 1.25);
      const target = elements(destination);
      const targetSpeed =
        Math.sqrt((6.67384e-11 * destination.parentMassKg!) / target.orbit.semiMajorAxis) / 1000;
      approachFuel = Math.floor(mixedBase + 4.5 + 0.1 * targetSpeed * (1 - tier));
      firstFuel = lastFuel = Math.floor(mixedBase + 6);
      if (gatewayFirst && !gatewayLast) {
        const share = tier / count;
        const gateMinimum = minimum(blocks[0].start!);
        const stationReserve = gateMinimum * (1 - share / 2);
        firstFuel = Math.floor(mixedBase + stationReserve + 1e-10);
        approachFuel = Math.floor(
          mixedBase + stationReserve - (gateMinimum - targetMinimum) * (1 - share) + 1e-10,
        );
      }
      if (noFirstTransfer) {
        firstFuel = 0;
      }
      if (noLastTransfer) {
        lastFuel = 0;
      }
    }
    const stars = new Map(input.stars.map(x => [x.naturalId, x.position]));
    const vector = (from: string, to: string) => {
      const u = stars.get(from);
      const v = stars.get(to);
      requireInput(u !== undefined && v !== undefined, '星图缺少跃迁端点坐标');
      const length = Math.hypot(v.x - u.x, v.y - u.y, v.z - u.z);
      requireInput(length > 0 && Number.isFinite(length), '跃迁距离无效');
      return { x: (v.x - u.x) / length, y: (v.y - u.y) / length, z: (v.z - u.z) / length, length };
    };
    const offset = (point: Vector, dir: Vector, sign: number, station: boolean) => {
      const d = sign * (station ? 22_439_680.5 : 74_798_935);
      return { x: point.x + d * dir.x, y: point.y + d * dir.y, z: point.z + d * dir.z };
    };
    for (const [index, block] of blocks.entries()) {
      const first = index === 0;
      const last = index === blocks.length - 1;
      if (block.gateway) {
        if (first && !noFirstTransfer) {
          append('TRANSIT', transfer(origin, block.start!, now(), firstFuel).seconds, firstFuel);
        }
        for (const leg of block.legs) {
          append('TRANSIT', 10, 15);
          append('LOCK', 600, 5);
          append(
            'JUMP_GATEWAY',
            Math.floor((vector(leg.from, leg.to).length / 12) * 1_200_000) / 1000,
          );
          append('DECAY', 600, 5);
        }
        append('TRANSIT', 10, 15);
        if (last && !noLastTransfer) {
          append('TRANSIT', transfer(block.end!, destination, now(), lastFuel).seconds, lastFuel);
        }
        continue;
      }
      const from = first ? origin : blocks[index - 1].end!;
      const to = last ? destination : blocks[index + 1].start!;
      const vectors = block.legs.map(x => vector(x.from, x.to));
      const point = position(from, now());
      const distance = ellipseBetween(
        point,
        offset(point, vectors[0], 1, first && kind(q.origin) === 'STA'),
      ).length;
      const burn = Math.min(departureFuel, stlSaturationFuel(distance, a, flow));
      requireFuel(burn > 0 && approachFuel > 0, 'STL 余油不足以分配离港与进近段');
      const speed =
        naturalJumpSpeed(p.ftlMaxSpeed, p.minReactorUsage, q.reactorUsageFactor) *
        flightConditionMultiplier(q.condition);
      for (const [i, v] of vectors.entries()) {
        const fuel = naturalJumpFuel(v.length / 12, power!, q.reactorUsageFactor);
        if (i === 0) {
          append('DEPARTURE', stlTransferSeconds(distance, burn, a, flow), burn, fuel);
        } else {
          append(
            'CHARGE',
            naturalChargeSeconds(p.emitterChargeTime, p.maxOverchargeTime, q.reactorUsageFactor),
            0,
            fuel,
          );
        }
        append('JUMP', Math.floor(v.length / 12 / speed));
      }
      const start = offset(
        position(to, now()),
        vectors.at(-1)!,
        -1,
        last && kind(q.destination) === 'STA',
      );
      append('APPROACH', fromPoint(start, to, now(), approachFuel).seconds, approachFuel);
    }
  }
  if (lands) {
    append('LANDING', down.seconds, down.fuel);
  }
  const stlShortage = Math.max(0, totals.stlFuel - q.stlFuel);
  const ftlShortage = Math.max(0, totals.ftlFuel - q.ftlFuel);
  const warnings: string[] = [];
  if (q.preferences.useGateways && !route.some(x => x.gate !== undefined)) {
    // 勾了网关却按纯自然跃迁算：把原因说出来，别让玩家以为网关生效了。
    warnings.push(
      input.gatewayConnections.length === 0
        ? `已勾选网关，但本地没有网关连接数据（网关实体 ${input.gateways.length} 个）：请点 FTC 面板的「网关」按钮获取网关快照后重试`
        : gatewayRouteAvailable(q, bp, input)
          ? '已勾选网关，但按当前跃迁偏好（最少跳数/最短 FTL）自然航线更优，所以没走网关'
          : '已勾选网关，但此航线按当前偏好不需要网关；当前按纯自然跃迁计算',
    );
  }
  const endpointGateway =
    (route[0]?.gate !== undefined && kind(q.origin) === 'PLA') ||
    (route.at(-1)?.gate !== undefined && kind(q.destination) === 'PLA');
  if (endpointGateway) {
    warnings.push(
      '网关段位于航线首/末段且端点是行星：该形状只有单条原生样本核对过，请按原生计划确认。',
    );
  }
  if (estimatedLanding) {
    warnings.push('着陆任务尚未确定，按停泊高度中值估算。实际着陆用时和耗油会随任务变化。');
  }
  if (mixedNeedsBlindTest) {
    warnings.push('此混合路径已通过现有数据回放，独立盲测尚未完成，请按原生计划确认。');
  }
  if (
    hasNatural &&
    engine?.option === 'STL_ENGINE_HYPERTHRUST' &&
    !q.landing &&
    q.fuelUsageFactor <= 0.1
  ) {
    warnings.push('超推力低档入轨存在进近偏差，建议核对原生计划。');
  }
  return {
    ...totals,
    segments,
    route,
    reactorRelevant: hasNatural,
    estimatedLanding,
    warnings,
    stlShortage,
    ftlShortage,
    feasible: stlShortage === 0 && ftlShortage === 0,
    stlRemaining: q.stlFuel - totals.stlFuel,
    ftlRemaining: q.ftlFuel - totals.ftlFuel,
    arrivalTimeMs: timeMs + totals.seconds * 1000,
  };
}

export type FormulaFlight = ReturnType<typeof predictFormulaFlight>;
