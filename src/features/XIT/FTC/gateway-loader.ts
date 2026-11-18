// 网关数据运行时加载：网关实体只由服务器在收到 DATA_GET_DATA{path:['gateways']}
// 时下发（DATA_DATA["gateways"]）——原生星图窗口打开时发的就是这一条请求，
// 所以插件发同一条请求即可拿到数据，不需要真的把星图开出来。
//
// 触发条件受 ToS 硬规则约束（docs/contributing.md：触发服务器通信的动作必须来自玩家点击）：
// **只有玩家的显式点击可以调用本模块**（FTC 面板的「网关」按钮 / 导出按钮）。
// 本模块不开任何窗口——早期实现曾在请求没回包时退回「开一次隐藏 MAP」，而隐藏 buffer 是
// 开发者特批的单点例外，不得扩展；把兜底留在这里等于让任何无点击路径都能开窗口。
// 没有点击的路径（SFC 滑块联动、FLEET 重算）只读已入库的数据，缺数据时由
// flight-formula 的 warning 说明成因。
//
// 同一会话内带冷却，避免连点把请求打得太密。
import { routesStore } from '@src/infrastructure/fio/routes';
import { sendServerMessage } from '@src/infrastructure/prun-api/socket-io-middleware';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { sleep } from '@src/utils/sleep';

// 同一次会话内的触发冷却：数据没到时不要因为用户改一个字就重发请求。
const RETRY_COOLDOWN_MS = 60_000;

let lastAttemptAt = 0;

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
// 只能由玩家点击触发（见文件头）。
export async function ensureGatewayConnections(
  options: EnsureGatewaysOptions = {},
): Promise<boolean> {
  const { timeoutMs = 8000, cooldownMs = RETRY_COOLDOWN_MS, pollMs = 200 } = options;
  if (routesStore.gatewayConnectionCount > 0) {
    return true;
  }
  const now = Date.now();
  if (now - lastAttemptAt < cooldownMs) {
    return routesStore.gatewayConnectionCount > 0;
  }
  lastAttemptAt = now;
  // socket 未就绪时发不出去：直接返回 false，不重试也不开窗口。
  if (!requestGatewayData()) {
    return false;
  }
  return waitForConnections(now + timeoutMs, pollMs);
}
