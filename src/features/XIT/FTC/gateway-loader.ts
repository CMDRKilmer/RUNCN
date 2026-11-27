// 网关数据运行时加载：网关实体只由服务器在收到 DATA_GET_DATA{path:['gateways']}
// 时下发（DATA_DATA["gateways"]）——原生星图窗口打开时发的就是这一条请求，
// 所以插件发同一条请求即可拿到数据，不需要真的把星图开出来。
//
// FTC 打开时预读，计算与扫描共用尚未完成的请求。SFC 和 FLEET 只读已入库的数据。
import { routesStore } from '@src/infrastructure/fio/routes';
import { sendServerMessage } from '@src/infrastructure/prun-api/socket-io-middleware';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { sleep } from '@src/utils/sleep';

// 同一次会话内的触发冷却：数据没到时不要因为用户改一个字就重发请求。
const RETRY_COOLDOWN_MS = 60_000;

let lastAttemptAt = 0;
let pending: Promise<boolean> | undefined;

export interface EnsureGatewaysOptions {
  // 等待网关连接入库的总时长；超时后返回 false（调用方按「仍不可达」处理）。
  timeoutMs?: number;
  // 冷却（两次请求之间的最小间隔）。
  cooldownMs?: number;
  pollMs?: number;
}

// 请求服务器下发网关快照（请求体与原生星图发出的完全一致）。
export function requestGatewayData() {
  return sendServerMessage({
    messageType: 'DATA_GET_DATA',
    payload: { path: ['gateways'], filters: null, actionId: crypto.randomUUID() },
    contextId: companyContextId.value,
  });
}

async function waitForConnections(deadline: number, pollMs: number) {
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (routesStore.gatewayConnectionCount > 0) {
      return true;
    }
  }
  return routesStore.gatewayConnectionCount > 0;
}

// 返回是否已有可用的网关连接。已有数据时完全无副作用（不发请求）。
export async function ensureGatewayConnections(
  options: EnsureGatewaysOptions = {},
): Promise<boolean> {
  const { timeoutMs = 8000, cooldownMs = RETRY_COOLDOWN_MS, pollMs = 200 } = options;
  if (routesStore.gatewayConnectionCount > 0) {
    return true;
  }
  if (pending !== undefined) {
    return pending;
  }
  const now = Date.now();
  if (now - lastAttemptAt < cooldownMs) {
    return routesStore.gatewayConnectionCount > 0;
  }
  // socket 未就绪时发不出去：直接返回 false，不重试也不开窗口。
  if (!requestGatewayData()) {
    return false;
  }
  lastAttemptAt = now;
  pending = waitForConnections(now + timeoutMs, pollMs).finally(() => {
    pending = undefined;
  });
  return pending;
}
