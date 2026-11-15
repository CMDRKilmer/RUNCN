import { onApiMessageForce } from '@src/infrastructure/prun-api/data/api-messages';
import { createEntityStore } from '@src/infrastructure/prun-api/data/create-entity-store';
import { sendServerMessage } from '@src/infrastructure/prun-api/socket-io-middleware';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';

// 原生「航线执行」对象（游戏 RTE 窗口的数据源）。订阅 SHIP_ROUTES_EXECUTION(S)
// 报文（走强制通道，见下方注册处），并配合一次按需的 SHIP_ROUTES_GET_EXECUTIONS
// 请求，用于把 XIT FLT 面板里的状态指示器与原生信号对齐。
export interface RouteExecution {
  shipId: string;
  // 执行状态，取值见 ExecutionState（PLANNING / FLYING / RUNNING_STEPS / WAITING /
  // AWAITING_MISSION / STEP_BLOCKED / BLOCKED …），决定 RTE 航点前指示器的颜色。
  state?: string;
  waypointIndex?: number;
  stepIndex?: number;
  // 执行所绑定的航线（含 id / naturalId / name / waypoints）。
  route?: {
    id: string;
    naturalId?: string;
    name?: string | null;
  };
}

// 按 shipId 建键：执行对象本身带 shipId，直接按船匹配，不必再经 assignedRoute。
const store = createEntityStore<RouteExecution>({ selectId: x => x.shipId });

// 走强制通道（onApiMessageForce）而不是普通通道：本 store 的数据来自插件自己
// 发起的 SHIP_ROUTES_GET_EXECUTIONS。普通通道在「URL 上下文不属于本公司」时
// （例如政府管理视图）会被 prun-api-listener 整条丢弃，响应收不到但请求已发出，
// 指示器会一直停在未同步。FLEET/native-route-socket.ts 的航线响应同样走强制通道。
onApiMessageForce({
  SHIP_ROUTES_EXECUTIONS(data: { executions?: RouteExecution[] }) {
    if (data?.executions !== undefined) {
      store.setAll(data.executions);
      // 只有整表列表才算「已拉取」。fetched 是调用方判断「还要不要发请求」的依据，
      // 单条执行事件只覆盖某一艘船，不能拿它冒充整表已完成。
      store.setFetched();
    }
  },
  SHIP_ROUTES_EXECUTION(data: RouteExecution & { execution?: RouteExecution }) {
    const execution = data?.execution ?? data;
    if (execution?.shipId !== undefined) {
      store.setOne(execution);
    }
  },
});

export const routeExecutionsStore = store.state;

// 主动请求一次原生航线执行数据（游戏动作名 SHIP_ROUTES_GET_EXECUTIONS）。响应走
// socket 分发 → 被上面的强制通道订阅收下。返回 false 表示 socket 尚未就绪或
// 上下文未知，调用方宜稍后重试。
// actionId 必须放在 payload 内：原生航线协议所有动作（含 GET_ROUTES）都是
// `payload: { actionId }` + 顶层 contextId，见 FLEET/native-route-socket.ts。
export function requestRouteExecutions(): boolean {
  if (companyContextId.value === undefined || companyContextId.value === '') {
    return false;
  }
  return sendServerMessage({
    messageType: 'SHIP_ROUTES_GET_EXECUTIONS',
    payload: { actionId: crypto.randomUUID() },
    contextId: companyContextId.value,
  });
}

export type RouteIndicatorStatus = 'ok' | 'warning' | 'error';

// 与游戏原生判定逐字一致：把执行状态映射为指示器颜色类别。
// ok = 正常，warning = 警告，其余（含 BLOCKED 等）= 异常。
export function executionIndicatorStatus(state: string | undefined): RouteIndicatorStatus {
  switch (state) {
    case 'PLANNING':
    case 'FLYING':
    case 'RUNNING_STEPS':
    case 'WAITING':
      return 'ok';
    case 'AWAITING_MISSION':
    case 'STEP_BLOCKED':
      return 'warning';
    default:
      return 'error';
  }
}
