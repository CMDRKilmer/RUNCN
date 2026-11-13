import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';
import type { NativeRouteStep } from './native-route-plan';

// 向导创建过的原生 RT 航线（FLEET 里只读展示；游戏侧的真实内容以原生 RT 为准）。
export interface NativeRouteWaypointRecord {
  location: string;
  // 游戏内部编码地址（游戏 UI 手动创建的航线才有）：位置换不回 naturalId 时用它匹配航班。
  encoded?: string;
  fuelPercent: number;
  reactorPercent?: number;
  // 该航点的「使用跃迁点」偏好：时长是按对应航线（网关 / 自然）算的。
  useGateways?: boolean;
  // 该航点是否着陆：着陆/起飞的时间与燃料都不同，时长按它算。
  landing?: boolean;
  // 飞到该航点的预计飞行时长（小时）：FTC 模型选点或 BTF 试飞实测时顺带记下。
  flightHours?: number;
  steps: NativeRouteStep[];
}

export interface NativeRouteRecord {
  // 服务端航线 id（哈希）。
  routeId: string;
  // 游戏内航线号（RT-XXXX-NNNN）：`RT <naturalId>` 才是打开窗口的命令。
  naturalId: string;
  // 计划写入的航线名（产业链名称）。
  name: string;
  shipId: string;
  shipLabel: string;
  chainName: string;
  createdAt: number;
  waypoints: NativeRouteWaypointRecord[];
}

// 按**公司**分键：同一浏览器里换公司后，上一个公司的航线号属于另一个账号，
// 校准会把它们当成「游戏里已删除」永久清掉（连带产业链名与预计时长）。
const STORAGE_PREFIX = 'rprun.fleet.native-route.v2';
// 旧版按浏览器全局存，没有公司维度：一次性归到当前公司，避免多公司互相删记录。
const LEGACY_KEY = 'rprun.fleet.native-route.v1';

const records = ref<Record<string, NativeRouteRecord>>({});
// 当前读写用的 localStorage 键；公司未知（USER_DATA 未到）时为空 = 不读不写。
let storageKey = '';

function readStored(key: string) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as Record<string, NativeRouteRecord>);
  } catch {
    return undefined;
  }
}

function loadCompany(companyId: string | undefined) {
  if (companyId === undefined || companyId === '') {
    return;
  }
  const key = `${STORAGE_PREFIX}.${companyId}`;
  if (key === storageKey) {
    return;
  }
  storageKey = key;
  let stored = readStored(key);
  if (stored === undefined) {
    const legacy = readStored(LEGACY_KEY);
    if (legacy !== undefined) {
      stored = legacy;
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // 配额/权限问题忽略：下次仍会读旧键，行为等同迁移前。
      }
    }
  }
  records.value = stored ?? {};
}

watch(() => userDataStore.companyId, loadCompany, { immediate: true });
watch(records, value => {
  if (storageKey === '') {
    return;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // 写入失败只影响下次打开时的恢复，不影响当前会话。
  }
});

export const nativeRouteRecords = records;

export function recordNativeRoute(record: NativeRouteRecord) {
  records.value = { ...records.value, [record.routeId]: record };
}

// 游戏里删除航线后同步移除记录，FLEET 的「运行中」也就不会再显示。
export function removeNativeRoute(routeId: string) {
  if (!(routeId in records.value)) {
    return;
  }
  const next = { ...records.value };
  delete next[routeId];
  records.value = next;
}

// 该船最近一次创建的原生 RT。
export function nativeRouteForShip(shipId: string | undefined) {
  if (shipId === undefined) {
    return undefined;
  }
  return Object.values(records.value)
    .filter(x => x.shipId === shipId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}
