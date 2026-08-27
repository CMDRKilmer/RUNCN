// 全部星球 STL 段数据自动采集器。
//
// 原理：游戏飞行计划计算（BTF/SFC）是服务器端完成的——客户端通过
// socket.io 发送 SHIP_FLIGHT_CALCULATE_TEST_FLIGHT（origin/destination 用
// "{systemId}|PLA|STA,{bodyId}" 编码），服务器回 ACTION_COMPLETED 包裹的
// SHIP_FLIGHT_MISSION（含 DEPARTURE/APPROACH 段原生 stlDistance）。
//
// RPrun 已劫持游戏 socket（socket-io-middleware），这里复用同一连接**真实发送**
// 请求（sendServerMessage）并匹配响应（missionId/queryId），因此可以**不依赖
// BTF 面板**批量请求。每次响应的 SHIP_FLIGHT_MISSION 会自动进入 system-bodies.ts
// 的 recordStlSegments（离港/进近按 出发天体|首跳星系 / 末跳星系|目标天体 记录），
// 采集即自动入库，FTC 精确复用。
//
// 星球列表：内置 public/json/fallback-fio-responses/allplanets.json（完整 4155 行星）。
// 实体 id：按系统逐个 NOMENCLATURE_QUERY_ADDRESSES 查询（缓存），从地址行取
// SYSTEM/PLANET 实体 id。
//
// 规模：4155 行星 × 2 请求（离港+进近）≈ 8310 次服务器计算，耗时较长；
// 支持并发窗口、取消、进度持久化（localStorage，重启后断点续采）。

import { onApiMessageForce } from './api-messages';
import { sendServerMessage } from '../socket-io-middleware';
import { companyContextId } from './user-data';
import { blueprintsStore } from './blueprints';
import { stationsStore } from './stations';
import config from '@src/infrastructure/shell/config';
import { sleep } from '@src/utils/sleep';
import { watchUntil } from '@src/utils/watch';

// ---- 响应匹配（按请求自造的 missionId / queryId 关联）----

const pendingQueries = new Map<string, (data: { addresses: PrunApi.Address[] }) => void>();
const pendingMissions = new Map<string, (data: PrunApi.FlightPlan) => void>();

// 用强制通道接收响应（prun-api-listener 无条件分发，绕过上下文检查）：
// 采集时游戏可能处于非公司上下文，正常通道会把响应丢弃。
onApiMessageForce({
  NOMENCLATURE_ADDRESSES_QUERY_DATA(data: { queryId: string; addresses: PrunApi.Address[] }) {
    const resolve = pendingQueries.get(data.queryId);
    if (resolve) {
      pendingQueries.delete(data.queryId);
      resolve(data);
    }
  },
  SHIP_FLIGHT_MISSION(data: PrunApi.FlightPlan) {
    const resolve = pendingMissions.get(data.missionId);
    if (resolve) {
      pendingMissions.delete(data.missionId);
      resolve(data);
    }
  },
});

function sendMessage(message: Record<string, unknown>) {
  const sent = sendServerMessage({
    ...message,
    actionId: crypto.randomUUID(),
    contextId: companyContextId.value,
  });
  if (!sent) {
    throw new Error('游戏 socket 未就绪：请刷新游戏页面后重试');
  }
}

// NOMENCLATURE 地址查询：返回该查询的全部地址（含实体 id）。
function queryAddresses(query: string, timeoutMs = 12000): Promise<PrunApi.Address[] | undefined> {
  const queryId = 'rprun-' + crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingQueries.delete(queryId);
      resolve(undefined);
    }, timeoutMs);
    pendingQueries.set(queryId, data => {
      clearTimeout(timer);
      pendingQueries.delete(queryId);
      resolve(data.addresses);
    });
    sendMessage({
      to: 'nomenclature-registry',
      messageType: 'NOMENCLATURE_QUERY_ADDRESSES',
      payload: {
        queryId,
        query,
        types: ['PLANET', 'SATELLITE', 'STATION'],
      },
    });
  });
}

// 请求一次测试飞行计划（BTF 等价），返回响应或超时 undefined。
function calculateTestFlight(
  origin: string,
  destination: string,
  blueprintId: string,
  timeoutMs = 15000,
): Promise<PrunApi.FlightPlan | undefined> {
  const missionId = crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingMissions.delete(missionId);
      resolve(undefined);
    }, timeoutMs);
    pendingMissions.set(missionId, data => {
      clearTimeout(timer);
      pendingMissions.delete(missionId);
      resolve(data);
    });
    sendMessage({
      messageType: 'SHIP_FLIGHT_CALCULATE_TEST_FLIGHT',
      payload: {
        missionId,
        blueprintId,
        origin,
        destination,
        landing: true,
        fuelUsageFactor: 0.05,
        reactorUsageFactor: 0.6510416666666667,
        payload: 0,
        condition: 1,
        stlFuel: 1500,
        ftlFuel: 300,
        preferences: { ftlPreference: 'LEAST_JUMPS', useGateways: true },
      },
    });
  });
}

// 把地址编码为飞行计划请求的 origin/destination："{systemId}|PLA|STA,{bodyId}"。
function encodeAddress(address: PrunApi.Address): string | undefined {
  const system = address.lines.find(l => l.type === 'SYSTEM')?.entity;
  const body = address.lines.find(l => l.type === 'PLANET' || l.type === 'STATION')?.entity;
  if (!system?.id || !body?.id) {
    return undefined;
  }
  const kind = address.lines.some(l => l.type === 'STATION') ? 'STA' : 'PLA';
  return `${system.id}|${kind},${body.id}`;
}

// 解析探针天体（行星或空间站）的地址。空间站名与 naturalId 不一致
// （搜索框建议显示 "Hortus Station (Hortus)"），先从 stationsStore 转名称再查询。
async function resolveEntity(naturalId: string): Promise<PrunApi.Address | undefined> {
  const station = stationsStore.getByNaturalId(naturalId);
  const query = station?.name ?? naturalId;
  const addresses = await queryAddresses(query);
  if (!addresses) {
    return undefined;
  }
  const up = naturalId.toUpperCase();
  return addresses.find(a => {
    const planet = a.lines.find(l => l.type === 'PLANET')?.entity;
    const stationLine = a.lines.find(l => l.type === 'STATION')?.entity;
    return (
      (planet !== undefined && planet.naturalId.toUpperCase() === up) ||
      (stationLine !== undefined && stationLine.name.toUpperCase() === up)
    );
  });
}

// ---- 星球列表 ----

interface AllPlanetRow {
  PlanetNaturalId: string;
  PlanetName: string;
}

let allPlanetCache: AllPlanetRow[] | undefined;

async function loadAllPlanets(): Promise<AllPlanetRow[]> {
  if (allPlanetCache !== undefined) {
    return allPlanetCache;
  }
  const resp = await fetch(config.url.allplanets);
  allPlanetCache = (await resp.json()) as AllPlanetRow[];
  return allPlanetCache;
}

function systemIdOf(planetNaturalId: string): string | undefined {
  return planetNaturalId.match(/^([A-Z]{2}-\d{3})/)?.[1];
}

// ---- 进度持久化（断点续采）----

const PROGRESS_KEY = 'rprun.ftc.collect-progress.v1';

function loadProgress(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveProgress(progress: Set<string>) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...progress]));
  } catch {
    // 超出配额忽略，仅影响续采
  }
}

export function clearCollectProgress() {
  localStorage.removeItem(PROGRESS_KEY);
}

export function collectProgressCount(): number {
  return loadProgress().size;
}

// ---- 主采集流程 ----

export interface CollectStlOptions {
  // 探针天体 naturalId（所有行星的离港/进近都以它为目标/来源）。
  probe: string;
  // 并发窗口（同时计算多少个行星，每行星 2 个请求串行）。默认 4。
  concurrency?: number;
  onProgress?: (info: { done: number; total: number; current: string; message: string }) => void;
  shouldCancel?: () => boolean;
}

export interface CollectStlResult {
  ok: number;
  failed: string[];
  cancelled: boolean;
}

export async function collectAllPlanetStl(options: CollectStlOptions): Promise<CollectStlResult> {
  const concurrency = Math.max(1, Math.min(12, options.concurrency ?? 4));
  const probeAddr = await resolveEntity(options.probe);
  if (!probeAddr) {
    throw new Error(`无法解析探针天体「${options.probe}」，请确认名称正确`);
  }
  const probeEnc = encodeAddress(probeAddr);
  if (!probeEnc) {
    throw new Error(`探针天体「${options.probe}」缺少实体 id`);
  }

  // 蓝图 id：采集请求需要有效的飞船蓝图。访问 store 会触发游戏 UI 的
  // 蓝图请求（createRequestStore），带超时等待返回。
  blueprintsStore.request();
  const bpReady = watchUntil(() => blueprintsStore.fetched.value || false)
    .then(() => true)
    .catch(() => false);
  const ready = await Promise.race([bpReady, sleep(20000).then(() => false)]);
  const blueprint = ready ? blueprintsStore.all.value?.[0] : undefined;
  if (!blueprint) {
    throw new Error('没有可用的飞船蓝图，请先在游戏里打开一次蓝图界面');
  }

  const planets = await loadAllPlanets();
  const total = planets.length;
  const doneSet = loadProgress();
  const failed: string[] = [];
  let finished = 0;
  let cancelled = false;

  const report = (current: string, message: string) => {
    options.onProgress?.({
      done: doneSet.size,
      total,
      current,
      message,
    });
  };

  // 系统地址缓存：每个系统只查一次，取回该系统全部行星实体。
  const systemCache = new Map<string, PrunApi.Address[]>();

  const collectOne = async (planet: AllPlanetRow) => {
    const pid = planet.PlanetNaturalId;
    try {
      if (doneSet.has(pid)) {
        return;
      }
      const sysId = systemIdOf(pid);
      if (!sysId) {
        failed.push(`${pid} (无法识别系统)`);
        return;
      }
      let addresses = systemCache.get(sysId);
      if (!addresses) {
        addresses = (await queryAddresses(sysId)) ?? [];
        systemCache.set(sysId, addresses);
      }
      const planetAddress = addresses.find(a =>
        a.lines.some(l => l.type === 'PLANET' && l.entity?.naturalId === pid),
      );
      if (!planetAddress) {
        failed.push(`${pid} (系统查询无此行星)`);
        return;
      }
      const planetEnc = encodeAddress(planetAddress);
      if (!planetEnc) {
        failed.push(`${pid} (编码失败)`);
        return;
      }
      if (planetEnc === probeEnc) {
        // 探针自身：跳过（无需给自己算）
        doneSet.add(pid);
        saveProgress(doneSet);
        return;
      }
      // 离港：行星 -> 探针
      const k1 = await calculateTestFlight(planetEnc, probeEnc, blueprint.id);
      // 进近：探针 -> 行星
      const k2 = await calculateTestFlight(probeEnc, planetEnc, blueprint.id);
      if (!k1 || !k2) {
        failed.push(`${pid} (计算超时)`);
        return;
      }
      doneSet.add(pid);
      saveProgress(doneSet);
    } catch (e) {
      failed.push(`${pid} (${String(e).slice(0, 40)})`);
    } finally {
      finished++;
    }
  };

  const queue = [...planets];
  const workers = Array.from({ length: concurrency }, async () => {
    while (!cancelled && queue.length > 0) {
      if (options.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      const planet = queue.shift();
      if (planet) {
        report(planet.PlanetNaturalId, `采集 ${finished + 1}/${total}`);
        await collectOne(planet);
      }
    }
  });

  await Promise.all(workers);
  if (cancelled) {
    return { ok: doneSet.size, failed, cancelled: true };
  }
  return { ok: doneSet.size, failed, cancelled: false };
}
