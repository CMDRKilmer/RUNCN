// 网关数据运行时加载：网关实体只由服务器在收到 DATA_GET_DATA{path:['gateways']}
// 时下发（DATA_DATA["gateways"]）——原生星图窗口打开时发的就是这一条请求，
// 所以插件直接发同一条请求即可拿到数据，**不需要真的把星图开出来**
// （早期实现用隐藏 MAP 窗口，实测拿不到数据，玩家仍要手动开星图）。
//
// 只有「玩家需要走网关 + 目前一条连接都没有」时才触发；带冷却，避免每次输入都请求一遍。
// 直接请求 2.5 s 内没回包（或被服务器忽略）时，才退回「开一次隐藏星图」兜底。
import { computed } from 'vue';
import { routesStore } from '@src/infrastructure/fio/routes';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sendServerMessage } from '@src/infrastructure/prun-api/socket-io-middleware';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { sleep } from '@src/utils/sleep';

// 同一次会话内的触发冷却：数据没到时不要因为用户改一个字就重发请求。
const RETRY_COOLDOWN_MS = 60_000;

let lastAttemptAt = 0;

export interface EnsureGatewaysOptions {
  // 等待网关连接入库的总时长；超时后返回 false（调用方按「仍不可达」处理）。
  timeoutMs?: number;
  // 直接请求的回包等待窗口：超时后才退回「开隐藏星图」兜底。
  requestTimeoutMs?: number;
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

function openHiddenStarMap() {
  // 让游戏自己发那条 DATA_GET_DATA；数据到达后自动关闭。
  void showBuffer('MAP', {
    autoClose: true,
    closeWhen: computed(() => routesStore.gatewayConnectionCount > 0),
  });
}

// 返回是否已有可用的网关连接。已有数据时完全无副作用（不发请求）。
export async function ensureGatewayConnections(
  options: EnsureGatewaysOptions = {},
): Promise<boolean> {
  const {
    timeoutMs = 8000,
    requestTimeoutMs = 2500,
    cooldownMs = RETRY_COOLDOWN_MS,
    pollMs = 200,
  } = options;
  if (routesStore.gatewayConnectionCount > 0) {
    return true;
  }
  const now = Date.now();
  if (now - lastAttemptAt < cooldownMs) {
    return routesStore.gatewayConnectionCount > 0;
  }
  lastAttemptAt = now;
  // 首选：自己发一条 DATA_GET_DATA（不开窗口）。只有它没回包时才退回开隐藏星图。
  const sent = requestGatewayData() && (await waitForConnections(now + requestTimeoutMs, pollMs));
  if (!sent) {
    openHiddenStarMap();
  }
  return waitForConnections(now + timeoutMs, pollMs);
}
