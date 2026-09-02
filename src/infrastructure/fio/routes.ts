import { ref } from 'vue';
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { getSystemLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';

// 跃迁网络：内置恒星连接（离线）+ 在线网关（DATA_DATA["gateways"] + 飞行计划）。
// 提供 BFS 最短跃迁路径（航线规划前置数据）与网关查询。
//
// 数据来源：
// - 内置 star-connections.json：SYSTEM_STARS_DATA 的 connections（恒星天然跃迁航线）。
// - 在线网关实体两条来源：
//   1) DATA_DATA["gateways"]：打开星图（星系地图）后客户端一次性下发全部网关
//      （naturalId、所属星系/行星、名称、状态），全量刷新。
//   2) NOMENCLATURE_ADDRESSES_QUERY_DATA：地址查询响应中可能含 SATELLITE 行
//      （网关实体），增量补充（网关是玩家动态建造/拆毁的，零散查询也能积累）。
// - 网关跃迁连接两条来源：
//   1) 名称配对（主要，一次性）：网关名称格式 "本地端 -> 远程端"，成对网关的
//      名称两端互为匹配（如 "Promitor -> Amethyst B" ⇄ "Amethyst B -> Promitor"），
//      配对即得连接两端星系，无需解析行星别名到星系；
//   2) SHIP_FLIGHT_MISSION 的 JUMP_GATEWAY 段（补充/校验）：该段 origin/destination
//      各含一条 SYSTEM 行，可直接建立连接并记录精确跃迁距离（pc）。

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
// 星系 naturalId → 相邻星系 naturalId（无向）。含内置跃迁连接与已观测网关连接。
const neighbors = new Map<string, Set<string>>();
// 星系 naturalId → 网关列表。
const gateways = new Map<string, GatewayInfo[]>();
let bundledLoaded = false;

// 一条已观测的网关跃迁连接（网关两端星系），来自 JUMP_GATEWAY 段。
// fromSystem/toSystem 为字典序归一化的星系 naturalId（无向）。
export interface GatewayConnection {
  fromSystem: string;
  toSystem: string;
  // 两端网关 naturalId（如 GTW-KZD-715 / GTW-FMX-128），可观测到时记录。
  fromGatewayId?: string;
  toGatewayId?: string;
  // 跃迁距离（pc），段上存在 ftlDistance 时记录。
  ftlDistance?: number;
  // 观测次数（同一连接可能被多份计划/往返记录）。
  seen: number;
}

// 已观测的网关连接，键为 "小星系|大星系"。
const gatewayConnections = new Map<string, GatewayConnection>();

function gatewayIdOf(address: PrunApi.Address | undefined): string | undefined {
  const lines = address?.lines;
  const last = lines?.[lines.length - 1];
  return last !== undefined && last.type === 'SATELLITE' ? last.entity?.naturalId : undefined;
}

function recordGatewayConnection(
  fromSystem: string,
  toSystem: string,
  fromGatewayId: string | undefined,
  toGatewayId: string | undefined,
  ftlDistance: number | undefined,
) {
  let a = fromSystem.toUpperCase();
  let b = toSystem.toUpperCase();
  let gA = fromGatewayId;
  let gB = toGatewayId;
  if (a === b) {
    return;
  }
  if (a > b) {
    // 归一化：字典序小的在前，网关 id 跟随所属星系。
    [a, b] = [b, a];
    [gA, gB] = [gB, gA];
  }
  const key = `${a}|${b}`;
  const existing = gatewayConnections.get(key);
  if (existing) {
    existing.seen++;
    existing.fromGatewayId = existing.fromGatewayId ?? gA;
    existing.toGatewayId = existing.toGatewayId ?? gB;
    existing.ftlDistance = existing.ftlDistance ?? ftlDistance;
  } else {
    gatewayConnections.set(key, {
      fromSystem: a,
      toSystem: b,
      fromGatewayId: gA,
      toGatewayId: gB,
      ftlDistance,
      seen: 1,
    });
    // 网关是可用航线：加入跃迁图，findShortestPath 即可走网关。
    addNeighbor(a, b);
  }
  routesVersion.value++;
}

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

// 网关名称配对：DATA_DATA["gateways"] 一次性下发全部网关实体后，
// 从名称（"本地端 -> 远程端"）配对出连接。成对网关的名称两端互为匹配：
// 网关 X(本地 A, 远程 B) 与网关 Y(本地 B', 远程 A') 构成连接，当
// X.远程≈Y.本地 且 Y.远程≈X.本地（相等或别名前缀匹配，如 "Griff"≈"Griffonstone"）。
function pairGatewayConnections() {
  interface Parsed {
    id: string;
    sys: string;
    local?: string;
    remote?: string;
  }
  const all: Parsed[] = [];
  for (const list of gateways.values()) {
    for (const g of list) {
      const m = g.name.match(/^(.*?)\s*(?:-{1,2}>|→)\s*(.*?)$/);
      all.push({
        id: g.naturalId,
        sys: g.systemId,
        local: m ? m[1].trim() : undefined,
        remote: m ? m[2].trim() : undefined,
      });
    }
  }
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[‐\-–—]/g, '');
  // 名称端匹配：完全相等，或别名前缀（一端是另一端前缀，至少 3 字符）。
  const match = (a: string | undefined, b: string | undefined) => {
    if (!a || !b) {
      return false;
    }
    const na = norm(a);
    const nb = norm(b);
    if (na === nb) {
      return true;
    }
    const minLen = 3;
    return (na.length >= minLen && nb.startsWith(na)) || (nb.length >= minLen && na.startsWith(nb));
  };
  const seen = new Set<string>();
  for (const x of all) {
    if (!x.local || !x.remote) {
      continue;
    }
    for (const y of all) {
      if (y.id === x.id || !y.local || !y.remote) {
        continue;
      }
      // 双向验证：x 连向 y，y 也连向 x。
      if (!match(x.remote, y.local) || !match(y.remote, x.local)) {
        continue;
      }
      const key = [x.id, y.id].sort().join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      // 距离未知（配对不含 pc），由 JUMP_GATEWAY 段观测补全。
      recordGatewayConnection(x.sys, y.sys, x.id, y.id, undefined);
    }
  }
}

export const routesStore = {
  get version() {
    return routesVersion.value;
  },
  get bundledLoaded() {
    return bundledLoaded;
  },
  // 某星系的邻接星系（内置跃迁连接 + 网关连接）。
  getNeighbors(systemNaturalId: string): string[] {
    void routesVersion.value;
    return [...(neighbors.get(systemNaturalId.toUpperCase()) ?? [])];
  },
  // 两星系间是否存在网关跃迁连接（无向）。
  isGatewayEdge(a: string, b: string): boolean {
    void routesVersion.value;
    const key = [a.toUpperCase(), b.toUpperCase()].sort().join('|');
    return gatewayConnections.has(key);
  },
  // BFS 最短跃迁路径（星系 naturalId 序列，含起终点）；不可达返回 undefined。
  // 路径可同时使用内置跃迁连接与已观测的网关连接。
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
  // 全部已加载网关（跨星系合并），供导出。
  getAllGateways(): GatewayInfo[] {
    void routesVersion.value;
    const all: GatewayInfo[] = [];
    for (const list of gateways.values()) {
      all.push(...list);
    }
    return all;
  },
  get gatewayCount() {
    void routesVersion.value;
    let count = 0;
    for (const list of gateways.values()) {
      count += list.length;
    }
    return count;
  },
  // 已观测的网关跃迁连接（跨星系合并，无向去重）。
  getGatewayConnections(): GatewayConnection[] {
    void routesVersion.value;
    return [...gatewayConnections.values()];
  },
  get gatewayConnectionCount() {
    void routesVersion.value;
    return gatewayConnections.size;
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
    // 一次性配对：从全部网关实体的名称提取连接（无需飞行）。
    pairGatewayConnections();
    routesVersion.value++;
  },
  // 地址查询响应中可能含网关实体（SATELLITE 行）：增量补充网关列表并重新配对。
  // 网关是玩家动态建造/拆毁的，每次查询都能发现新网关（如换线后的新网关）。
  NOMENCLATURE_ADDRESSES_QUERY_DATA(data: {
    addresses?: Array<{
      lines?: Array<{ type: string; entity?: { naturalId?: string; name?: string } }>;
    }>;
  }) {
    let added = false;
    for (const addr of data.addresses ?? []) {
      const lines = addr.lines ?? [];
      const sysLine = lines.find(l => l.type === 'SYSTEM');
      const satLine = lines.find(l => l.type === 'SATELLITE');
      const sys = sysLine?.entity?.naturalId;
      const gid = satLine?.entity?.naturalId;
      if (!sys || !gid) {
        continue;
      }
      const key = sys.toUpperCase();
      const list = gateways.get(key) ?? [];
      if (!list.some(g => g.naturalId === gid)) {
        list.push({
          naturalId: gid,
          name: satLine.entity?.name ?? gid,
          systemId: key,
          planetId: lines.find(l => l.type === 'PLANET')?.entity?.naturalId,
          // 地址查询不含运营状态，默认视为运营中。
          operational: true,
        });
        gateways.set(key, list);
        added = true;
      }
    }
    if (added) {
      pairGatewayConnections();
      routesVersion.value++;
    }
  },
  // 从飞行计划补充网关跃迁连接（配对遗漏时兜底，并记录精确跃迁距离）：
  // JUMP_GATEWAY 段的 origin/destination 各含一条 SYSTEM 行 = 网关两端星系。
  SHIP_FLIGHT_MISSION(data: PrunApi.FlightPlan) {
    for (const seg of data.segments) {
      if (seg.type !== 'JUMP_GATEWAY') {
        continue;
      }
      const fromSys = getSystemLineFromAddress(seg.origin)?.entity?.naturalId;
      const toSys = getSystemLineFromAddress(seg.destination)?.entity?.naturalId;
      if (!fromSys || !toSys) {
        continue;
      }
      recordGatewayConnection(
        fromSys,
        toSys,
        gatewayIdOf(seg.origin),
        gatewayIdOf(seg.destination),
        seg.ftlDistance ?? undefined,
      );
    }
  },
});
