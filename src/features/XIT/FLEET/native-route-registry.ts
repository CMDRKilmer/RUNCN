import { persistedRef } from '@src/utils/persisted-ref';
import type { NativeRouteStep } from './native-route-plan';

// 向导创建过的原生 RT 航线（FLEET 里只读展示；游戏侧的真实内容以原生 RT 为准）。
export interface NativeRouteWaypointRecord {
  location: string;
  // 游戏内部编码地址（游戏 UI 手动创建的航线才有）：位置换不回 naturalId 时用它匹配航班。
  encoded?: string;
  fuelPercent: number;
  reactorPercent?: number;
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

const records = persistedRef<Record<string, NativeRouteRecord>>('rprun.fleet.native-route.v1', {});

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
