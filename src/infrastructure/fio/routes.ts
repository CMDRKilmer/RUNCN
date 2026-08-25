import { ref } from 'vue';
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

// 跃迁网络：内置恒星连接（离线）+ 在线网关（DATA_DATA["gateways"]）。
// 提供 BFS 最短跃迁路径（航线规划前置数据）与网关查询。
//
// 数据来源：
// - 内置 star-connections.json：SYSTEM_STARS_DATA 的 connections（恒星天然跃迁航线）。
// - 在线网关：用户浏览相关界面时客户端自动请求 DATA_DATA["gateways"]，
//   记录网关（naturalId、所属星系/行星、名称、状态）。网关提供天然连接之外的
//   额外跃迁航线（连接目标在其名称中，如 "Amethyst B -> Promitor"）。

export interface GatewayInfo {
  naturalId: string;
  name: string;
  // 所属星系 naturalId（网关地址的 SYSTEM 行）。
  systemId: string;
  // 所在行星 naturalId（网关绕行星轨道运行）。
  planetId?: string;
  operational: boolean;
}

const routesVersion = ref(0);
// 星系 naturalId → 相邻星系 naturalId（无向）。
const neighbors = new Map<string, Set<string>>();
// 星系 naturalId → 网关列表。
const gateways = new Map<string, GatewayInfo[]>();
let bundledLoaded = false;

function addNeighbor(a: string, b: string) {
  const ka = a.toUpperCase();
  const kb = b.toUpperCase();
  if (ka === kb) {
    return;
  }
  let set = neighbors.get(ka);
  if (!set) {
    set = new Set();
    neighbors.set(ka, set);
  }
  set.add(kb);
  let setB = neighbors.get(kb);
  if (!setB) {
    setB = new Set();
    neighbors.set(kb, setB);
  }
  setB.add(ka);
}

export const routesStore = {
  get version() {
    return routesVersion.value;
  },
  get bundledLoaded() {
    return bundledLoaded;
  },
  // 某星系的邻接星系（内置跃迁连接）。
  getNeighbors(systemNaturalId: string): string[] {
    void routesVersion.value;
    return [...(neighbors.get(systemNaturalId.toUpperCase()) ?? [])];
  },
  // BFS 最短跃迁路径（星系 naturalId 序列，含起终点）；不可达返回 undefined。
  findShortestPath(from: string, to: string): string[] | undefined {
    void routesVersion.value;
    const start = from.toUpperCase();
    const end = to.toUpperCase();
    if (start === end) {
      return [start];
    }
    const prev = new Map<string, string | null>();
    const queue = [start];
    prev.set(start, null);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === end) {
        break;
      }
      for (const next of neighbors.get(cur) ?? []) {
        if (!prev.has(next)) {
          prev.set(next, cur);
          queue.push(next);
        }
      }
    }
    if (!prev.has(end)) {
      return undefined;
    }
    const path: string[] = [];
    let node: string | undefined = end;
    while (node !== undefined) {
      path.unshift(node);
      node = prev.get(node) ?? undefined;
    }
    return path;
  },
  // 某星系的网关列表（在线 DATA_DATA 积累）。
  getGateways(systemNaturalId: string): GatewayInfo[] {
    void routesVersion.value;
    return gateways.get(systemNaturalId.toUpperCase()) ?? [];
  },
  get gatewayCount() {
    void routesVersion.value;
    let count = 0;
    for (const list of gateways.values()) {
      count += list.length;
    }
    return count;
  },
};

// 启动时加载内置恒星连接（离线可用）。
async function loadBundledConnections() {
  try {
    const resp = await fetch(config.url.starConnections);
    const data = (await resp.json()) as Record<string, string[]>;
    for (const [sys, conns] of Object.entries(data)) {
      for (const c of conns) {
        addNeighbor(sys, c);
      }
    }
    bundledLoaded = true;
    routesVersion.value++;
  } catch {
    // 内置连接加载失败：仅靠在线数据。
  }
}
void loadBundledConnections();

// 在线读取网关。
interface GatewayRaw {
  naturalId?: string;
  name?: string;
  address?: {
    lines?: Array<{ type: string; entity?: { naturalId?: string } }>;
  };
  operationalState?: string;
}

onApiMessage({
  DATA_DATA(data: { path?: string[]; body?: unknown }) {
    const path = data.path;
    if (!Array.isArray(path) || path[0] !== 'gateways' || !Array.isArray(data.body)) {
      return;
    }
    gateways.clear();
    for (const g of data.body as GatewayRaw[]) {
      const lines = g.address?.lines ?? [];
      const sysLine = lines.find(l => l.type === 'SYSTEM');
      const planetLine = lines.find(l => l.type === 'PLANET');
      const sys = sysLine?.entity?.naturalId;
      if (!sys || !g.naturalId) {
        continue;
      }
      const key = sys.toUpperCase();
      const list = gateways.get(key) ?? [];
      list.push({
        naturalId: g.naturalId,
        name: g.name ?? g.naturalId,
        systemId: key,
        planetId: planetLine?.entity?.naturalId,
        operational: g.operationalState === 'OPERATIONAL',
      });
      gateways.set(key, list);
    }
    routesVersion.value++;
  },
});
