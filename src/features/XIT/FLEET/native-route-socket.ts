import { onApiMessageForce } from '@src/infrastructure/prun-api/data/api-messages';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
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
  minimum?: { units?: number };
  maximum?: { units?: number };
  retain?: number;
}

export interface RouteWaypointData {
  id: string;
  landing: boolean;
  fuelUsageFactor: number;
  reactorUsageFactor: number;
  steps: RouteStepData[];
}

export interface RouteData {
  id: string;
  naturalId: string;
  name?: string | null;
  waypoints: RouteWaypointData[];
}

const ROUTE_TIMEOUT_MS = 15000;
// 服务端不回 actionId，只能按「一次请求一份响应」的顺序匹配（所有请求串行 await）。
// 变更类请求回 SHIP_ROUTES_ROUTE（单条），删除等回 SHIP_ROUTES_ROUTES（列表）。
type RouteResponse = { kind: 'route'; route: RouteData } | { kind: 'routes'; routes: RouteData[] };

const pending = new Set<(response: RouteResponse) => void>();

onApiMessageForce({
  SHIP_ROUTES_ROUTE(data: RouteData) {
    dispatchRouteResponse({ kind: 'route', route: data });
  },
  SHIP_ROUTES_ROUTES(data: { routes?: RouteData[] }) {
    dispatchRouteResponse({ kind: 'routes', routes: data.routes ?? [] });
  },
});

function dispatchRouteResponse(response: RouteResponse) {
  const [resolve] = pending;
  if (resolve !== undefined) {
    pending.delete(resolve);
    resolve(response);
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

// 发一条航线请求，等第一条响应（不解释内容）。
function sendRouteRequest(messageType: string, payload: Record<string, unknown>) {
  return new Promise<RouteResponse>((resolve, reject) => {
    const done = (response: RouteResponse) => {
      clearTimeout(timer);
      pending.delete(done);
      resolve(response);
    };
    const timer = setTimeout(() => {
      pending.delete(done);
      reject(new Error(`${messageType} 无响应`));
    }, ROUTE_TIMEOUT_MS);
    pending.add(done);
    const sent = sendServerMessage({
      messageType,
      payload: { ...payload, actionId: crypto.randomUUID() },
      contextId: companyContextId.value,
    });
    if (!sent) {
      clearTimeout(timer);
      pending.delete(done);
      reject(new Error('游戏 socket 未就绪，请刷新页面后重试'));
    }
  });
}

function sendRouteAction(messageType: string, payload: Record<string, unknown>, routeId?: string) {
  return serialize(async () => {
    const response = await sendRouteRequest(messageType, payload);
    const route =
      response.kind === 'route'
        ? response.route
        : routeId === undefined
          ? undefined
          : response.routes.find(x => x.id === routeId);
    if (route === undefined) {
      throw new Error(`${messageType} 未返回航线数据`);
    }
    return route;
  });
}

export async function socketCreateRoute() {
  return await sendRouteAction('SHIP_ROUTES_CREATE_ROUTE', {});
}

// 写航线期间禁止其它模块插入航线类请求（串行队列已经兜住，这里是额外的显示层守卫）。
let activeSessions = 0;

export function hasPendingRouteRequest() {
  return activeSessions > 0 || pending.size > 0;
}

// 拉取游戏里现有的航线：用来丢弃本地记录里已被删掉的航线（包括在游戏 UI 里删的）。
export async function socketGetRoutes() {
  return await serialize(async () => {
    const response = await sendRouteRequest('SHIP_ROUTES_GET_ROUTES', {});
    return response.kind === 'routes' ? response.routes : [response.route];
  });
}

// 删除航线：响应是航线列表（SHIP_ROUTES_ROUTES），列表里已无该 routeId 才算删掉。
export async function socketDeleteRoute(routeId: string) {
  await serialize(async () => {
    const response = await sendRouteRequest('SHIP_ROUTES_DELETE_ROUTE', { routeId });
    if (response.kind === 'routes' && response.routes.some(x => x.id === routeId)) {
      throw new Error('服务端仍返回该航线，删除未生效');
    }
  });
}

export async function socketAddWaypoint(routeId: string, destination: string) {
  return await sendRouteAction('SHIP_ROUTES_ADD_WAYPOINT', { routeId, destination }, routeId);
}

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
      preferences: { ftlPreference: 'LEAST_JUMPS', useGateways: true },
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

export interface SocketWriteInput {
  waypoints: readonly NativeWaypoint[];
  // 与 waypoints 等长（首站不写档位）。
  legs: readonly { fuelPercent: number; reactorPercent?: number }[];
  name: string;
}

export interface SocketWriteResult {
  routeId: string;
  naturalId: string;
  // 未能写入的部分，由对话框提示。
  warnings: string[];
}

// 一次性写完：建航线 → 逐站加航点/写档位/加步骤/写数量 → 改名。
// 全部走 socket，不开窗口、不点 UI。
export async function writeNativeRouteBySocket(
  input: SocketWriteInput,
  signal: AbortSignal,
  onProgress: (status: string) => void,
): Promise<SocketWriteResult> {
  const codes = new Map<string, string>();
  const addressCode = async (location: string) => {
    const key = location.trim().toUpperCase();
    const cached = codes.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const address = await resolveEntity(location);
    const code = address === undefined ? undefined : encodeAddress(address);
    if (code === undefined) {
      throw new Error(`无法解析 ${location} 的地址。`);
    }
    codes.set(key, code);
    return code;
  };

  onProgress('创建航线');
  activeSessions++;
  try {
    return await writeRoute(input, signal, onProgress, addressCode);
  } finally {
    activeSessions--;
  }
}

async function writeRoute(
  input: SocketWriteInput,
  signal: AbortSignal,
  onProgress: (status: string) => void,
  addressCode: (location: string) => Promise<string>,
): Promise<SocketWriteResult> {
  const warnings: string[] = [];
  const created = await socketCreateRoute();
  let route = created;
  for (const [index, waypoint] of input.waypoints.entries()) {
    signal.throwIfAborted();
    onProgress(`写入航点 ${index + 1}/${input.waypoints.length} · ${waypoint.location}`);
    const destination = await addressCode(waypoint.location);
    route = await socketAddWaypoint(route.id, destination);
    const added = route.waypoints.at(-1);
    if (added === undefined) {
      throw new Error(`航点 ${waypoint.location} 未返回 id。`);
    }
    const leg = input.legs[index];
    if (leg !== undefined) {
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
      const type = step.kind === 'refuel' ? 'REFUEL' : step.kind === 'load' ? 'LOAD' : 'UNLOAD';
      route = await socketAddStep(route.id, added.id, type);
      const createdSteps = route.waypoints.at(-1)?.steps ?? [];
      if (createdSteps.length <= stepCount) {
        throw new Error(`${waypoint.location} 的 ${type} 步骤未返回 id。`);
      }
      stepCount = createdSteps.length;
      const stepId = createdSteps.at(-1)!.id;
      if (step.kind === 'refuel') {
        route = await socketEditRefuelStep(route.id, added.id, stepId, step.tank);
        continue;
      }
      const material = materialsStore.getByTicker(step.ticker);
      if (material === undefined) {
        throw new Error(`未找到材料 ${step.ticker}。`);
      }
      const stepType = step.kind === 'load' ? 'LOAD' : 'UNLOAD';
      route = await socketEditStep(route.id, added.id, stepId, stepType, material.id, step.amount);
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
