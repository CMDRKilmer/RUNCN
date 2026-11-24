import { onApiMessageForce } from '@src/infrastructure/prun-api/data/api-messages';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import {
  encodeAddress,
  resolveEntity,
} from '@src/infrastructure/prun-api/data/flight-test-collector';
import { sendServerMessage } from '@src/infrastructure/prun-api/socket-io-middleware';
import type { NativeWaypoint } from './native-route-plan';

// 原生 RT 的 socket 写入（协议来自游戏实采：SHIP_ROUTES_* 一组 action 消息）。
// 每次请求下发一份完整的 SHIP_ROUTES_ROUTE（含全部航点/步骤 id），据此串联后续请求。

export interface RouteStepData {
  id: string;
  type: string;
  material?: { id: string; ticker: string };
  // 补油步骤的油箱；游戏 UI 手动创建的航线可能没有绝对数量（type = CAPACITY）。
  fuel?: 'STL' | 'FTL';
  source?: string;
  minimum?: { type?: string; units?: number };
  maximum?: { type?: string; units?: number };
  retain?: number;
}

export interface RouteWaypointData {
  id: string;
  // 航点目的地。写入请求用 "{系统}|PLA|STA,{天体}" 编码字符串，但真实响应里
  // 是结构化对象（地址/实体），所以这里不能按 string 断言。
  destination?: unknown;
  landing: boolean;
  fuelUsageFactor: number;
  reactorUsageFactor: number;
  // 航线偏好：`useGateways` 决定走网关还是自然跃迁，直接改变距离、时长与消耗。
  preferences?: { ftlPreference?: string; useGateways?: boolean };
  steps: RouteStepData[];
}

export interface RouteData {
  id: string;
  naturalId: string;
  name?: string | null;
  // 循环开关，服务端响应已带该字段（实采 2026-11-19）。
  repeats?: boolean;
  waypoints: RouteWaypointData[];
}

const ROUTE_TIMEOUT_MS = 15000;

export class RouteCreateUnconfirmedError extends Error {}

// 服务端不回 actionId，只能按「一次请求一份响应」的顺序匹配（所有请求串行 await）。
// 变更类请求回 SHIP_ROUTES_ROUTE（单条），删除等回 SHIP_ROUTES_ROUTES（列表）。
// 游戏里其它窗口也可能同时发航线请求，因此每个请求带匹配谓词：响应与请求的
// 类型/航线 id 对不上就跳过，不会把别的航线的响应当成自己的。
type RouteResponse = { kind: 'route'; route: RouteData } | { kind: 'routes'; routes: RouteData[] };
type ResponseMatcher = (response: RouteResponse) => boolean;

interface PendingRequest {
  match: ResponseMatcher;
  resolve: (response: RouteResponse) => void;
}

const pending = new Set<PendingRequest>();

onApiMessageForce({
  SHIP_ROUTES_ROUTE(data: RouteData) {
    dispatchRouteResponse({ kind: 'route', route: data });
  },
  SHIP_ROUTES_ROUTES(data: { routes?: RouteData[] }) {
    dispatchRouteResponse({ kind: 'routes', routes: data.routes ?? [] });
  },
});

function dispatchRouteResponse(response: RouteResponse) {
  for (const request of pending) {
    if (!request.match(response)) {
      continue;
    }
    pending.delete(request);
    request.resolve(response);
    return;
  }
}

// 全局串行：服务端不回 actionId，只能靠「一次请求一份响应」的 FIFO 对位，
// 所以任何时刻只允许一条航线请求在飞（并发会让响应互相对错）。
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

// 发一条航线请求，等第一条**匹配**的响应（不解释内容）。
function sendRouteRequest(
  messageType: string,
  payload: Record<string, unknown>,
  match: ResponseMatcher = () => true,
) {
  return new Promise<RouteResponse>((resolve, reject) => {
    const request: PendingRequest = {
      match,
      resolve: response => {
        clearTimeout(timer);
        resolve(response);
      },
    };
    const timer = setTimeout(() => {
      pending.delete(request);
      reject(
        messageType === 'SHIP_ROUTES_CREATE_ROUTE'
          ? new RouteCreateUnconfirmedError('未能确认服务器是否已创建航线。')
          : new Error(`${messageType} 无响应`),
      );
    }, ROUTE_TIMEOUT_MS);
    pending.add(request);
    const sent = sendServerMessage({
      messageType,
      payload: { ...payload, actionId: crypto.randomUUID() },
      contextId: companyContextId.value,
    });
    if (!sent) {
      clearTimeout(timer);
      pending.delete(request);
      reject(new Error('游戏 socket 未就绪，请刷新页面后重试'));
    }
  });
}

function sendRouteAction(
  messageType: string,
  payload: Record<string, unknown>,
  routeId?: string,
  matches?: ResponseMatcher,
) {
  return serialize(async () => {
    const response = await sendRouteRequest(messageType, payload, response => {
      // 变更类 action 只回单条 SHIP_ROUTES_ROUTE：游戏里其它窗口的列表响应（哪怕带着
      // 本条航线）是**变更前**的状态，当成自己的响应会让后续步骤改错航点。
      if (response.kind !== 'route') {
        return false;
      }
      if (matches !== undefined && !matches(response)) {
        return false;
      }
      // 请求指定了航线就必须是这条航线——否则后续航点/改名会写到别的航线上。
      return routeId === undefined || response.route.id === routeId;
    });
    const route = response.kind === 'route' ? response.route : undefined;
    if (route === undefined) {
      throw new Error(`${messageType} 未返回航线数据`);
    }
    return route;
  });
}

// 建航线请求的响应里没有可对位的 id，而游戏里其它窗口的航线变更同样回单条
// SHIP_ROUTES_ROUTE。先记下现有航线 id，只接受**不在快照里**的那一条：否则会把别人的
// 航线当成本次新建，后续航点/改名会写到它上面，取消时还会删掉它。
export async function socketCreateRoute() {
  const existing = new Set((await socketGetRoutes()).map(x => x.id));
  return await sendRouteAction(
    'SHIP_ROUTES_CREATE_ROUTE',
    {},
    undefined,
    response => response.kind === 'route' && !existing.has(response.route.id),
  );
}

// 写航线期间禁止其它模块插入航线类请求（串行队列已经兜住，这里是额外的显示层守卫）。
let activeSessions = 0;

export function hasPendingRouteRequest() {
  return activeSessions > 0 || pending.size > 0;
}

// 拉取游戏里现有的航线：用来丢弃本地记录里已被删掉的航线（包括在游戏 UI 里删的）。
export async function socketGetRoutes() {
  return await serialize(async () => {
    // 只接受列表响应：单条 SHIP_ROUTES_ROUTE 可能来自游戏里其它窗口。
    const response = await sendRouteRequest('SHIP_ROUTES_GET_ROUTES', {}, x => x.kind === 'routes');
    return response.kind === 'routes' ? response.routes : [];
  });
}

// 删除航线：响应是航线列表（SHIP_ROUTES_ROUTES），列表里已无该 routeId 才算删掉。
export async function socketDeleteRoute(routeId: string) {
  await serialize(async () => {
    const response = await sendRouteRequest(
      'SHIP_ROUTES_DELETE_ROUTE',
      { routeId },
      x => x.kind === 'routes',
    );
    if (response.kind === 'routes' && response.routes.some(x => x.id === routeId)) {
      throw new Error('服务端仍返回该航线，删除未生效');
    }
  });
}

export async function socketAddWaypoint(routeId: string, destination: string) {
  return await sendRouteAction('SHIP_ROUTES_ADD_WAYPOINT', { routeId, destination }, routeId);
}

const waypointPreferences = { ftlPreference: 'LEAST_JUMPS', useGateways: true };

export async function socketEditWaypoint(
  routeId: string,
  waypointId: string,
  destination: string,
  fuelUsageFactor: number,
  reactorUsageFactor: number,
) {
  return await sendRouteAction(
    'SHIP_ROUTES_EDIT_WAYPOINT',
    {
      routeId,
      waypointId,
      destination,
      landing: true,
      fuelUsageFactor,
      reactorUsageFactor,
      // 与游戏自己写入航点时的默认偏好一致（实采值）。
      preferences: waypointPreferences,
    },
    routeId,
  );
}

export async function socketAddStep(
  routeId: string,
  waypointId: string,
  type: 'LOAD' | 'UNLOAD' | 'REFUEL',
) {
  return await sendRouteAction('SHIP_ROUTES_ADD_STEP', { routeId, waypointId, type }, routeId);
}

export async function socketEditStep(
  routeId: string,
  waypointId: string,
  stepId: string,
  type: 'LOAD' | 'UNLOAD',
  materialId: string,
  units: number,
) {
  return await sendRouteAction(
    `SHIP_ROUTES_EDIT_${type}_STEP`,
    {
      routeId,
      waypointId,
      stepId,
      material: materialId,
      minimum: { type: 'ABSOLUTE', units },
      maximum: { type: 'ABSOLUTE', units },
      retain: 0,
    },
    routeId,
  );
}

export async function socketRenameRoute(routeId: string, name: string) {
  return await sendRouteAction('SHIP_ROUTES_RENAME_ROUTE', { routeId, name }, routeId);
}

// 循环开关（实采 2026-11-19）：SHIP_ROUTES_SET_REPEAT 回单条 SHIP_ROUTES_ROUTE，repeats 已翻转。
// 与航点/步骤独立，套用 FIFO 串行 + 按 routeId 匹配；写入后直接用响应里的 repeats 校验。
export async function socketSetRouteRepeats(routeId: string, repeats: boolean) {
  const route = await sendRouteAction('SHIP_ROUTES_SET_REPEAT', { routeId, repeats }, routeId);
  if (route.repeats !== repeats) {
    throw new Error(`循环开关未生效（服务端 repeats=${String(route.repeats)}）。`);
  }
  return route;
}

// 补油步骤：source 固定本地仓库，上下限都用 CAPACITY（= 补满），与游戏 UI 的最终状态一致。
export async function socketEditRefuelStep(
  routeId: string,
  waypointId: string,
  stepId: string,
  fuel: 'STL' | 'FTL',
) {
  return await sendRouteAction(
    'SHIP_ROUTES_EDIT_REFUEL_STEP',
    {
      routeId,
      waypointId,
      stepId,
      fuel,
      source: 'LOCAL_STORE',
      minimum: { type: 'CAPACITY', units: 0 },
      maximum: { type: 'CAPACITY', units: 0 },
    },
    routeId,
  );
}

export async function checkNativeRoute(waypoints: readonly NativeWaypoint[], signal: AbortSignal) {
  const addresses = new Map<string, string | undefined>();
  const materialIds = new Map<string, string | undefined>();
  const issues: string[] = [];
  for (const waypoint of waypoints) {
    signal.throwIfAborted();
    const { location } = waypoint;
    if (!addresses.has(location)) {
      const knownAddress =
        sitesStore.getByPlanetNaturalId(location)?.address ??
        stationsStore.getByNaturalId(location)?.address;
      let address = knownAddress === undefined ? undefined : encodeAddress(knownAddress);
      if (address === undefined) {
        const resolved = await resolveEntity(location).catch(() => undefined);
        signal.throwIfAborted();
        address = resolved === undefined ? undefined : encodeAddress(resolved);
      }
      if (address === undefined) {
        issues.push(`无法确认航点 ${location} 的地址。`);
      }
      addresses.set(location, address);
    }
    for (const step of waypoint.steps) {
      if (step.kind === 'refuel') {
        continue;
      }
      if (!materialIds.has(step.ticker)) {
        materialIds.set(step.ticker, materialsStore.getByTicker(step.ticker)?.id);
      }
      if (materialIds.get(step.ticker) === undefined) {
        issues.push(`${location} · 找不到物料 ${step.ticker}。`);
      }
    }
  }
  return { addresses, materialIds, issues: [...new Set(issues)] };
}

export type CheckedRoute = Awaited<ReturnType<typeof checkNativeRoute>>;

interface SocketWriteInput {
  waypoints: readonly NativeWaypoint[];
  legs: readonly { fuelPercent: number; reactorPercent?: number }[];
  name: string;
  checkedRoute: CheckedRoute;
}

export interface SocketWriteResult {
  routeId: string;
  naturalId: string;
  // 未能写入的部分，由对话框提示。
  warnings: string[];
}

function waypointDestination(waypoint: RouteWaypointData) {
  const { destination } = waypoint;
  if (typeof destination === 'string') {
    return destination;
  }
  if (
    typeof destination === 'object' &&
    destination !== null &&
    'lines' in destination &&
    Array.isArray(destination.lines)
  ) {
    return encodeAddress(destination as PrunApi.Address);
  }
  return undefined;
}

// 一次性写完：建航线 → 逐站添加航点和步骤，按回包补写属性 → 改名。
// 全部走 socket，不开窗口、不点 UI。onCreated 在航线创建后立即回调，
// 中止写入时调用方可根据它删除半成品，避免下次重试再建一条重复航线。
export async function writeNativeRouteBySocket(
  input: SocketWriteInput,
  signal: AbortSignal,
  onProgress: (status: string) => void,
  onCreated?: (routeId: string, naturalId: string) => void,
): Promise<SocketWriteResult> {
  signal.throwIfAborted();
  const { addresses, materialIds, issues } = input.checkedRoute;
  if (issues.length !== 0) {
    throw new Error(issues.join('\n'));
  }
  const destinations = input.waypoints.map(waypoint => {
    const destination = addresses.get(waypoint.location);
    if (destination === undefined) {
      throw new Error(`航点 ${waypoint.location} 尚未校验。`);
    }
    for (const step of waypoint.steps) {
      if (step.kind !== 'refuel' && materialIds.get(step.ticker) === undefined) {
        throw new Error(`${waypoint.location} · 物料 ${step.ticker} 尚未校验。`);
      }
    }
    return destination;
  });
  onProgress('创建航线');
  activeSessions++;
  try {
    return await writeRoute(input, destinations, signal, onProgress, onCreated);
  } finally {
    activeSessions--;
  }
}

async function writeRoute(
  input: SocketWriteInput,
  destinations: readonly string[],
  signal: AbortSignal,
  onProgress: (status: string) => void,
  onCreated?: (routeId: string, naturalId: string) => void,
): Promise<SocketWriteResult> {
  const warnings: string[] = [];
  const created = await socketCreateRoute();
  onCreated?.(created.id, created.naturalId);
  let route = created;
  for (const [index, waypoint] of input.waypoints.entries()) {
    signal.throwIfAborted();
    onProgress(`写入航点 ${index + 1}/${input.waypoints.length} · ${waypoint.location}`);
    const destination = destinations[index]!;
    const before = route.waypoints.length;
    route = await socketAddWaypoint(route.id, destination);
    if (route.waypoints.length <= before) {
      throw new Error(`航点 ${waypoint.location} 未写入（响应里没有新航点）。`);
    }
    const added = route.waypoints.at(-1)!;
    const leg = input.legs[index];
    if (
      leg !== undefined &&
      (waypointDestination(added) !== destination ||
        added.landing !== true ||
        added.fuelUsageFactor !== leg.fuelPercent / 100 ||
        added.reactorUsageFactor !== (leg.reactorPercent ?? 50) / 100 ||
        added.preferences?.ftlPreference !== waypointPreferences.ftlPreference ||
        added.preferences.useGateways !== waypointPreferences.useGateways)
    ) {
      route = await socketEditWaypoint(
        route.id,
        added.id,
        destination,
        leg.fuelPercent / 100,
        (leg.reactorPercent ?? 50) / 100,
      );
    }
    let stepCount = route.waypoints.at(-1)?.steps.length ?? 0;
    for (const step of waypoint.steps) {
      signal.throwIfAborted();
      const materialStepType = step.kind === 'load' ? 'LOAD' : 'UNLOAD';
      const type = step.kind === 'refuel' ? 'REFUEL' : materialStepType;
      route = await socketAddStep(route.id, added.id, type);
      const createdSteps = route.waypoints.at(-1)?.steps ?? [];
      if (createdSteps.length <= stepCount) {
        throw new Error(`${waypoint.location} 的 ${type} 步骤未返回 id。`);
      }
      stepCount = createdSteps.length;
      const addedStep = createdSteps.at(-1)!;
      const stepId = addedStep.id;
      if (step.kind === 'refuel') {
        if (
          addedStep.type !== type ||
          addedStep.fuel !== step.tank ||
          addedStep.source !== 'LOCAL_STORE' ||
          addedStep.minimum?.type !== 'CAPACITY' ||
          addedStep.maximum?.type !== 'CAPACITY'
        ) {
          route = await socketEditRefuelStep(route.id, added.id, stepId, step.tank);
        }
        continue;
      }
      const materialId = input.checkedRoute.materialIds.get(step.ticker)!;
      if (
        addedStep.type !== type ||
        addedStep.material?.id !== materialId ||
        addedStep.minimum?.type !== 'ABSOLUTE' ||
        addedStep.minimum.units !== step.amount ||
        addedStep.maximum?.type !== 'ABSOLUTE' ||
        addedStep.maximum.units !== step.amount ||
        addedStep.retain !== 0
      ) {
        route = await socketEditStep(
          route.id,
          added.id,
          stepId,
          materialStepType,
          materialId,
          step.amount,
        );
      }
    }
  }
  const name = input.name.trim();
  if (name !== '') {
    signal.throwIfAborted();
    onProgress(`改名为 ${name}`);
    route = await socketRenameRoute(route.id, name);
  }
  return { routeId: route.id, naturalId: route.naturalId, warnings };
}
