import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { closePrunWindow } from '@src/infrastructure/prun-ui/utils/close-prun-window';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import {
  getSliderValue,
  releaseTile,
  reserveTile,
  setSliderValue,
} from '@src/infrastructure/prun-ui/utils/set-slider-value';
import { convertToPlanetNaturalId } from '@src/core/planet-natural-id';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightPlansStore } from '@src/infrastructure/prun-api/data/flight-plans';
import { systemBodiesStore } from '@src/infrastructure/prun-api/data/system-bodies';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { sleep } from '@src/utils/sleep';
import { changeInputValue } from '@src/utils/dom';
import { latestPlanForAddress, planReceivedAt } from './plan-tracker';

// FTC 参数扫描查询引擎。
// 原理：离屏打开 SFC 窗口 → 自动填目的地 → 逐组写入「燃料消耗/反应堆使用量」
// 滑块 → 每次写入后游戏服务器重算并下发 SHIP_FLIGHT_MISSION → 记录 → 关窗。
//
// 注意：
// - 窗口用 transform 移出屏幕而非 display:none —— 滑块写入依赖
//   getBoundingClientRect 计算百分比坐标，display:none 下矩形为 0。
// - 查询只填写目的地/滑块，绝不点击「开始」，不会触发实际飞行。
// - 通过 reserveTile 与 sfc-auto-fuel-settings 互斥，避免滑块互相覆盖。

export interface SweepCombo {
  fuel: number;
  reactor?: number;
}

export interface SweepOutcome {
  combo: SweepCombo;
  plan?: PrunApi.FlightPlan;
  error?: string;
}

export interface SweepOptions {
  // 扫描结束后依次切换到的后续航点：仅用于触发飞行计划、捕获天体位置
  // （transferEllipse 坐标由 system-bodies store 自动记录），不影响扫描结果。
  probeDestinations?: string[];
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  missionTimeoutMs?: number;
}

const FIND_TILE_ATTEMPTS = 20;
const FIND_TILE_INTERVAL_MS = 100;
const SLIDER_WRITE_RETRIES = 5;
const SLIDER_RETRY_DELAY_MS = 400;
const DEFAULT_MISSION_TIMEOUT_MS = 15000;
const MISSION_POLL_INTERVAL_MS = 150;
// 主动捕获标定锚点时的燃料滑块标定值：写入一个确定值，保证读到的
// 计划与该滑块值严格对应（被动读取存在 sfc-auto-fuel-settings 异步写
// 0.1 的竞态，可能读到与计划不符的值）。
const FUEL_CALIBRATION = 0.1;

async function waitFor(condition: () => boolean, timeoutMs: number, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return condition();
}

// 按标签识别 SFC 表单滑块（燃料消耗/反应堆使用量），标签不匹配时按
// DOM 顺序兜底（首个 = 燃料消耗，第二个 = 反应堆使用量）。
export function findSfcSliders(anchor: Element) {
  const sliders = _$$(anchor, 'rc-slider');
  const byLabel = new Map<string, Element>();
  for (const slider of sliders) {
    const row = slider.closest(
      `.${C.FormComponent.containerActive}, .${C.FormComponent.containerPassive}`,
    );
    const label = _$(row ?? slider, 'label')?.textContent?.trim();
    if (label) {
      byLabel.set(label, slider);
    }
  }
  const fuel = byLabel.get('燃料消耗') ?? sliders[0];
  const reactor = byLabel.get('反应堆使用量') ?? sliders.at(1);
  return { fuel, reactor };
}

function missionSignature(tile: PrunTile) {
  const stats = _$(tile.anchor, C.MissionPlan.stats);
  const table = _$(tile.anchor, C.MissionPlan.table);
  return `${table !== undefined ? (getPrunId(table) ?? '') : ''}|${stats?.textContent ?? ''}`;
}

// 读取当前飞行计划：优先 DOM 表格 prun-id（精确关联，且必须为新下发），
// 失败或读到旧计划时降级为按飞船地址 + 目的地 + 到达时间匹配最近计划。
// destinationId 用于限定计划目的地，避免同一飞船地址的多份历史计划错配。
function readPlan(tile: PrunTile, ship: PrunApi.Ship, sinceMs?: number, destinationId?: string) {
  const table = _$(tile.anchor, C.MissionPlan.table);
  const missionId = table !== undefined ? getPrunId(table) : null;
  if (missionId) {
    const plan = flightPlansStore.getById(missionId);
    const receivedAt = planReceivedAt(missionId);
    const fresh = sinceMs === undefined || (receivedAt !== undefined && receivedAt >= sinceMs);
    if (plan !== undefined && fresh) {
      return plan;
    }
  }
  return latestPlanForAddress(ship.address, sinceMs, destinationId);
}

async function writeSliders(tile: PrunTile, combo: SweepCombo) {
  for (let attempt = 0; attempt < SLIDER_WRITE_RETRIES; attempt++) {
    const { fuel, reactor } = findSfcSliders(tile.anchor);
    if (fuel === undefined) {
      return false;
    }
    let ok = await setSliderValue(fuel, combo.fuel);
    if (ok && reactor !== undefined && combo.reactor !== undefined) {
      ok = await setSliderValue(reactor, combo.reactor);
    }
    if (ok) {
      return true;
    }
    await sleep(SLIDER_RETRY_DELAY_MS);
  }
  return false;
}

async function findTile(window: HTMLElement) {
  for (let attempt = 0; attempt < FIND_TILE_ATTEMPTS; attempt++) {
    const body = _$(window, C.Window.body);
    const tileEl = body ? _$(body, C.Tile.tile) : undefined;
    const tile = tileEl ? tiles.findByContainer(tileEl.parentElement!)[0] : undefined;
    if (tile) {
      return tile;
    }
    await sleep(FIND_TILE_INTERVAL_MS);
  }
  return undefined;
}

async function submitCommand(window: HTMLElement, command: string) {
  const input = _$(window, C.PanelSelector.input) as HTMLInputElement | undefined;
  if (!input?.form?.isConnected) {
    throw new Error('未找到命令输入框');
  }
  changeInputValue(input, command);
  await sleep(0);
  input.form.requestSubmit();
}

/**
 * 在离屏 SFC 窗口中执行回调：打开窗口 → 提交命令 → 定位 tile → 独占滑块 →
 * 执行 fn → 释放并关窗。窗口用 transform 移出屏幕但保留布局（滑块坐标计算
 * 依赖 getBoundingClientRect 的非零矩形）。
 */
async function withSfcWindow<T>(registration: string, fn: (tile: PrunTile) => Promise<T>) {
  const ship = shipsStore.getByRegistration(registration);
  if (!ship) {
    throw new Error(`未找到飞船 ${registration}`);
  }
  if (ship.flightId !== null) {
    throw new Error(`${registration} 正在飞行中，仅支持停靠中的飞船`);
  }

  const window = (await showBuffer(`SFC ${registration}`, {
    force: true,
    autoSubmit: false,
  })) as HTMLElement;
  const prevTransform = window.style.transform;
  // 移出屏幕但保留布局：滑块坐标计算依赖非零矩形。
  window.style.transform = 'translate(-200vw, -200vh)';

  let reservedAnchor: Element | undefined;
  try {
    await submitCommand(window, `SFC ${registration}`);
    const tile = await findTile(window);
    if (!tile) {
      throw new Error('SFC 窗口加载超时');
    }
    reservedAnchor = tile.anchor;
    reserveTile(tile.anchor);
    return await fn(tile);
  } finally {
    if (reservedAnchor !== undefined) {
      releaseTile(reservedAnchor);
    }
    window.style.transform = prevTransform;
    closePrunWindow(window);
  }
}

// 切换 SFC 目的地并等待新的飞行计划下发（missionId 变化）。
async function selectDestination(tile: PrunTile, destination: string, timeoutMs: number) {
  const container = _$(tile.anchor, C.AddressSelector.container);
  if (!container) {
    return false;
  }
  const signature = missionSignature(tile);
  const selected = await selectAddress(container, destination);
  if (!selected) {
    return false;
  }
  await waitFor(() => missionSignature(tile) !== signature, timeoutMs, MISSION_POLL_INTERVAL_MS);
  await sleep(50);
  return true;
}

/**
 * 对指定飞船执行「目的地 × 参数组合」扫描，返回每组组合的服务器精确飞行计划。
 * 任一组合失败不中断整体扫描（记录 error 继续下一组）。
 * 扫描结束后依次切换到 probeDestinations 各航点，捕获天体位置供多段估算使用。
 */
export async function runSweep(
  registration: string,
  destination: string,
  combos: SweepCombo[],
  options?: SweepOptions,
): Promise<SweepOutcome[]> {
  return withSfcWindow(registration, async tile => {
    const ship = shipsStore.getByRegistration(registration)!;
    const missionTimeout = options?.missionTimeoutMs ?? DEFAULT_MISSION_TIMEOUT_MS;
    const destId = convertToPlanetNaturalId(destination) ?? destination;
    const sweepStartMs = Date.now();
    const results: SweepOutcome[] = [];

    // 填写目的地（触发首份飞行计划）。
    const addressContainer = await $(tile.anchor, C.AddressSelector.container);
    const selected = await selectAddress(addressContainer, destId);
    if (!selected) {
      throw new Error(`目的地「${destId}」选择失败，未找到匹配建议`);
    }

    // 等待首份飞行计划渲染（MissionPlan 统计区）。
    const missionReady = await waitFor(
      () => _$(tile.anchor, C.MissionPlan.stats) !== undefined,
      missionTimeout,
    );
    if (!missionReady) {
      throw new Error('飞行计划加载超时（目的地可能无效）');
    }

    // 记录初始滑块值与对应计划：首个组合若恰与初始值一致可直接复用，
    // 避免写入相同值不触发服务器重算导致等待超时。
    const initial = findSfcSliders(tile.anchor);
    const initialFuel = initial.fuel !== undefined ? getSliderValue(initial.fuel) : undefined;
    const initialReactor =
      initial.reactor !== undefined ? getSliderValue(initial.reactor) : undefined;
    const initialPlan = readPlan(tile, ship, sweepStartMs);

    // 后续航点（去重，排除扫描目的地本身）：仅用于触发飞行计划、捕获位置。
    const probeDests: string[] = [];
    const seen = new Set([destId.toUpperCase()]);
    for (const waypoint of options?.probeDestinations ?? []) {
      const id = convertToPlanetNaturalId(waypoint) ?? waypoint;
      if (!seen.has(id.toUpperCase())) {
        seen.add(id.toUpperCase());
        probeDests.push(id);
      }
    }
    const total = combos.length + probeDests.length;

    let done = 0;
    for (const combo of combos) {
      if (options?.isCancelled?.()) {
        break;
      }

      const matchesInitial =
        initialPlan !== undefined &&
        initialFuel !== undefined &&
        Math.abs(initialFuel - combo.fuel) < 0.01 &&
        (combo.reactor === undefined ||
          initialReactor === undefined ||
          Math.abs(initialReactor - combo.reactor) < 0.01);

      let plan: PrunApi.FlightPlan | undefined;
      if (matchesInitial) {
        plan = initialPlan;
      } else {
        const signature = missionSignature(tile);
        const written = await writeSliders(tile, combo);
        if (!written) {
          results.push({ combo, error: '滑块写入失败' });
          done++;
          options?.onProgress?.(done, total);
          continue;
        }
        // 等待游戏重算下发新的飞行计划（MissionPlan 统计文本变化）。
        const changed = await waitFor(
          () => missionSignature(tile) !== signature,
          missionTimeout,
          MISSION_POLL_INTERVAL_MS,
        );
        if (!changed) {
          results.push({ combo, error: '等待飞行计划更新超时' });
          done++;
          options?.onProgress?.(done, total);
          continue;
        }
        // 等一拍让 store 消化消息后再读取。
        await sleep(50);
        plan = readPlan(tile, ship, sweepStartMs);
      }

      if (plan) {
        results.push({ combo, plan });
      } else {
        results.push({ combo, error: '未能读取飞行计划' });
      }
      done++;
      options?.onProgress?.(done, total);
    }

    // 依次切换到后续航点：每次地址变更触发服务器下发新飞行计划，
    // 计划各段的 transferEllipse 坐标由 system-bodies store 自动记录。
    for (const dest of probeDests) {
      if (options?.isCancelled?.()) {
        break;
      }
      await selectDestination(tile, dest, missionTimeout);
      done++;
      options?.onProgress?.(done, total);
    }

    return results;
  });
}

/**
 * 打开离屏 SFC 窗口，依次选择各航点触发飞行计划下发，从计划的
 * transferEllipse 捕获天体位置（system-bodies store 自动记录）。
 * 返回捕获期间新增的天体位置数量。
 */
export async function captureBodyPositions(
  registration: string,
  destinations: string[],
  options?: SweepOptions,
): Promise<number> {
  const before = systemBodiesStore.count;
  await withSfcWindow(registration, async tile => {
    const missionTimeout = options?.missionTimeoutMs ?? DEFAULT_MISSION_TIMEOUT_MS;
    // 飞船当前位置无需捕获（选择相同目的地不会触发新计划）。
    const shipAddress = shipsStore.getByRegistration(registration)?.address;
    const shipLocation =
      shipAddress !== null && shipAddress !== undefined
        ? getEntityNaturalIdFromAddress(shipAddress)
        : undefined;
    const seen = new Set<string>();
    if (shipLocation !== undefined) {
      seen.add(shipLocation.toUpperCase());
    }
    for (const dest of destinations) {
      if (options?.isCancelled?.()) {
        break;
      }
      const id = convertToPlanetNaturalId(dest) ?? dest;
      if (seen.has(id.toUpperCase())) {
        continue;
      }
      seen.add(id.toUpperCase());
      await selectDestination(tile, id, missionTimeout);
    }
  });
  return systemBodiesStore.count - before;
}

export interface AnchorCaptureResult {
  plan: PrunApi.FlightPlan;
  // 产生该计划时的燃料消耗滑块值（被动读取，不写入）。
  fuel: number;
  // 产生该计划时的反应堆使用量滑块值（无 FTL 段时可能缺失）。
  reactor?: number;
}

/**
 * 打开离屏 SFC 窗口捕获一份「标定计划」：仅选择目的地并等待服务器下发
 * 飞行计划，同时被动读取当前滑块值（绝不写入滑块）。配合 scaleCalibration
 * 即可本地推算任意参数组合，规避滑块写入不稳定的问题。
 */
export async function captureAnchor(
  registration: string,
  destination: string,
  options?: SweepOptions,
): Promise<AnchorCaptureResult> {
  return withSfcWindow(registration, async tile => {
    const ship = shipsStore.getByRegistration(registration)!;
    const missionTimeout = options?.missionTimeoutMs ?? DEFAULT_MISSION_TIMEOUT_MS;
    const destId = convertToPlanetNaturalId(destination) ?? destination;

    // 填写目的地（触发飞行计划下发）。
    const selectMs = Date.now() - 1000;
    const addressContainer = await $(tile.anchor, C.AddressSelector.container);
    const selected = await selectAddress(addressContainer, destId);
    if (!selected) {
      throw new Error(`目的地「${destId}」选择失败，未找到匹配建议`);
    }

    // 等待飞行计划渲染（MissionPlan 统计区）。
    const missionReady = await waitFor(
      () => _$(tile.anchor, C.MissionPlan.stats) !== undefined,
      missionTimeout,
    );
    if (!missionReady) {
      throw new Error('飞行计划加载超时（目的地可能无效）');
    }

    // 主动把燃料滑块写到确定值，保证读到的计划与该滑块值严格对应——
    // 被动读取存在与 sfc-auto-fuel-settings 的竞态：计划可能是旧滑块值
    // 生成的，而读到的滑块已是新值，二者错位导致后续缩放全错。
    const { fuel, reactor } = findSfcSliders(tile.anchor);
    if (fuel === undefined) {
      throw new Error('未能找到燃料消耗滑块');
    }
    const curFuel = getSliderValue(fuel);
    let plan: PrunApi.FlightPlan | undefined;
    if (curFuel !== undefined && Math.abs(curFuel - FUEL_CALIBRATION) < 0.01) {
      // 当前滑块已是标定值，直接读选目的地时下发的计划。
      plan = readPlan(tile, ship, selectMs, destId);
    } else {
      const beforeWriteMs = Date.now();
      const signature = missionSignature(tile);
      const written = await setSliderValue(fuel, FUEL_CALIBRATION);
      if (!written) {
        throw new Error('未能写入燃料消耗滑块');
      }
      // 等服务器按新滑块值重算并下发新计划。
      const recalculated = await waitFor(
        () => missionSignature(tile) !== signature,
        missionTimeout,
        MISSION_POLL_INTERVAL_MS,
      );
      if (!recalculated) {
        // 滑块已写入但服务器未重算：计划仍是旧滑块值，若继续会得到
        // 「旧滑块计划 + 新滑块 f0」的错位锚点，导致本地缩放全错。
        throw new Error('写入燃料滑块后服务器未重算计划，请重试');
      }
      await sleep(50);
      plan = readPlan(tile, ship, beforeWriteMs, destId);
    }
    if (!plan) {
      throw new Error('未能读取飞行计划');
    }

    // 用写入后的实际滑块值作为 f0（而非硬编码标定值）：即使实际生效值
    // 与标定值有偏差，锚点也与计划严格对应。
    const actualFuel = getSliderValue(fuel) ?? FUEL_CALIBRATION;
    const reactorValue = reactor !== undefined ? getSliderValue(reactor) : undefined;
    return { plan, fuel: actualFuel, reactor: reactorValue };
  });
}
