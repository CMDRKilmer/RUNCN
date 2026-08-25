import { ref } from 'vue';
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { isSameAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getSliderValue, isTileReserved } from '@src/infrastructure/prun-ui/utils/set-slider-value';
import { calibrate, Calibration } from './route-model';
import { findSfcSliders } from './flight-query';

// 飞船标定锚点：一份已知参数（燃料/反应堆滑块值、捕获时质量）下的
// 服务器飞行计划标定。配合 scaleCalibration 可本地推算任意参数组合，
// 无需再次打开 SFC 窗口。锚点按距离比例外推，不会因行星位置漂移过期；
// 质量变化由 scaleCalibration 的 √(m/m0) 修正处理。
//
// 来源：
// 1. 被动捕获：用户自己打开 SFC 预览飞行时，游戏下发 SHIP_FLIGHT_MISSION，
//    此时窗口内滑块值即该计划的参数——自动记录，用户无感。
//    （查询引擎独占的离屏窗口跳过：滑块写入与计划下发之间存在竞态。）
// 2. 主动捕获：FTC 本地计算模式首次使用时的 captureAnchor 查询。
// 3. 服务器扫描：runSweep 每组成功结果都是精确锚点（由 FTC.vue 保存）。

const CACHE_KEY = 'rprun.ftc.anchors.v1';

export interface ShipAnchor {
  registration: string;
  capturedMs: number;
  // 产生该计划时的燃料消耗滑块值（0–1）。
  fuel: number;
  // 产生该计划时的反应堆使用量滑块值（0–1，纯 STL 航线无此段）。
  reactor?: number;
  // 捕获时飞船质量（吨），用于装载量变化后的 √(m/m0) 时间修正。
  mass?: number;
  cal: Calibration;
}

const anchorsVersion = ref(0);
const anchors = new Map<string, ShipAnchor>();

function persist() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify([...anchors.values()]));
  } catch {
    // localStorage 不可用（隐私模式等）：仅内存缓存。
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return;
    }
    for (const anchor of JSON.parse(raw) as ShipAnchor[]) {
      if (anchor?.registration && anchor.cal !== undefined) {
        anchors.set(anchor.registration.toUpperCase(), anchor);
      }
    }
  } catch {
    // 缓存损坏：忽略，用新数据重建。
  }
}
restore();

export function getAnchor(registration: string): ShipAnchor | undefined {
  void anchorsVersion.value;
  return anchors.get(registration.toUpperCase());
}

export function saveAnchor(anchor: ShipAnchor) {
  anchors.set(anchor.registration.toUpperCase(), anchor);
  anchorsVersion.value++;
  persist();
}

// 从当前打开的 SFC 窗口被动读取滑块值，关联刚到达的飞行计划。
// 仅在一个未独占的 SFC 窗口且其飞船地址与计划起点一致时记录；
// 多窗口匹配（同地多船）时放弃，避免错误关联。
function capturePassively(plan: PrunApi.FlightPlan) {
  if (plan.segments.length === 0) {
    return;
  }
  const frames = Array.from(document.getElementsByClassName('rp-command-SFC'));
  let matched: { ship: PrunApi.Ship; fuel: number; reactor?: number } | undefined;
  for (const frame of frames) {
    const anchorElement = _$(frame, C.TileFrame.anchor);
    if (!anchorElement || isTileReserved(anchorElement)) {
      continue;
    }
    const command = _$(frame, C.TileFrame.cmd)?.textContent?.trim() ?? '';
    const registration = command.replace(/^SFC\s+/i, '').trim();
    const ship = shipsStore.getByRegistration(registration);
    if (!ship || !isSameAddress(plan.segments[0].origin, ship.address)) {
      continue;
    }
    const { fuel, reactor } = findSfcSliders(anchorElement);
    const fuelValue = fuel !== undefined ? getSliderValue(fuel) : undefined;
    if (fuelValue === undefined) {
      continue;
    }
    const reactorValue = reactor !== undefined ? getSliderValue(reactor) : undefined;
    if (matched !== undefined) {
      // 同一位置多个 SFC 窗口都能匹配：无法确定计划属于哪艘船。
      return;
    }
    matched = { ship, fuel: fuelValue, reactor: reactorValue };
  }
  if (matched === undefined) {
    return;
  }
  saveAnchor({
    registration: matched.ship.registration,
    capturedMs: Date.now(),
    fuel: matched.fuel,
    reactor: matched.reactor,
    mass: matched.ship.mass,
    cal: calibrate(plan),
  });
}

onApiMessage({
  SHIP_FLIGHT_MISSION(data: PrunApi.FlightPlan) {
    capturePassively(data);
  },
});
