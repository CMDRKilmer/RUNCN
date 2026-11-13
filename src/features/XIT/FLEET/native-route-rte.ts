import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { sleep } from '@src/utils/sleep';

// RTE（航线执行）是「哪艘船正在跑哪条航线」的唯一权威来源：SHIP_ROUTES_* 报文
// 只含航线定义，不含分配关系。行内航线号（RT-XXXX-NNNN）是 ASCII，与界面语言无关；
// 船按注册号（大小写无关）再按船名匹配本地 shipsStore。
const routeIdPattern = /RT-[A-Z0-9]+-\d+/i;

export interface RouteExecutionRow {
  text: string;
  // 游戏内航线号（RT-XXXX-NNNN）。
  naturalId?: string;
  shipId?: string;
}

// 读取所有正在执行航线的船。返回 undefined = 窗口没读到（调用方回退本地记录）；
// 返回 [] = 确实没有正在执行的航线。
// autoClose 让 window 全程保持隐藏（display:none 下游戏照常渲染），读完再关，
// 不会在玩家布局里闪一下。
export async function readRouteExecutions(): Promise<RouteExecutionRow[] | undefined> {
  const existing = tiles.find('RTE').find(x => x.frame.isConnected);
  if (existing !== undefined) {
    return await waitForRows(existing.frame, 1500);
  }
  const close = ref(false);
  try {
    const window = await showBuffer('RTE', { force: true, autoClose: true, closeWhen: close });
    return await waitForRows(window, 4000);
  } catch {
    return undefined;
  } finally {
    close.value = true;
  }
}

async function waitForRows(
  root: Element,
  timeoutMs: number,
): Promise<RouteExecutionRow[] | undefined> {
  const deadline = Date.now() + timeoutMs;
  let sawFrame = false;
  do {
    const frame = isRouteFrame(root) ? root : findRouteFrame(root);
    if (frame !== undefined) {
      sawFrame = true;
      const rows = readRows(frame);
      if (rows.length > 0) {
        return rows;
      }
      if (_$(frame, C.Tile.warning)?.textContent?.trim()) {
        return undefined;
      }
    }
    await sleep(50);
  } while (Date.now() < deadline);
  // 窗口渲染出来但没有执行行：确实没有正在跑的航线。
  return sawFrame ? [] : undefined;
}

function isRouteFrame(element: Element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  return normalize(_$(element, C.TileFrame.cmd)?.textContent) === 'RTE';
}

function findRouteFrame(root: Element) {
  for (const frame of _$$(root, C.TileFrame.frame)) {
    if (isRouteFrame(frame)) {
      return frame;
    }
  }
  return undefined;
}

function textOf(element: Element) {
  return element instanceof HTMLElement ? element.innerText : (element.textContent ?? '');
}

function readRows(frame: Element): RouteExecutionRow[] {
  const anchor = _$(frame, C.TileFrame.anchor) ?? frame;
  const tableRows = Array.from(anchor.querySelectorAll('tr'));
  const texts =
    tableRows.length > 0 ? tableRows.map(row => row.innerText) : textOf(anchor).split('\n');
  const rows: RouteExecutionRow[] = [];
  for (const text of texts) {
    const naturalId = text.match(routeIdPattern)?.[0]?.toUpperCase();
    const shipId = matchShipId(text);
    if (naturalId === undefined && shipId === undefined) {
      continue;
    }
    rows.push({ text, naturalId, shipId });
  }
  return rows;
}

function matchShipId(text: string) {
  const ships = shipsStore.all.value;
  if (ships === undefined) {
    return undefined;
  }
  const upper = text.toUpperCase();
  const byRegistration = ships.find(
    x => x.registration !== '' && upper.includes(x.registration.toUpperCase()),
  );
  if (byRegistration !== undefined) {
    return byRegistration.id;
  }
  // 船名是玩家自定义文本：区分大小写、要求完整词边界；命中多个（如「Cargo 1」与
  // 「Cargo 10」同时命中同一条文本）时视为不确定，交给调用方按航班推断。
  const byName = ships.filter(x => x.name !== '' && containsName(text, x.name));
  return byName.length === 1 ? byName[0]!.id : undefined;
}

function containsName(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function normalize(text: string | null | undefined) {
  return (text ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}
