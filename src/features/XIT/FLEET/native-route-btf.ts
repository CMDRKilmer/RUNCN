import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { flightPlansStore } from '@src/infrastructure/prun-api/data/flight-plans';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';
import { closePrunWindow } from '@src/infrastructure/prun-ui/utils/close-prun-window';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import {
  findFormSlider,
  getSliderRange,
  getSliderValue,
  setSliderValue,
} from '@src/infrastructure/prun-ui/utils/set-slider-value';
import { changeInputValue } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';
import {
  autoFuelGrid,
  findBalanceOption,
  type FuelTradeoff,
} from '@src/features/XIT/FTC/fuel-model';
import { summarizeNativeFlightPlan } from '@src/features/XIT/FTC/route-planner';
import type { ShipChainPlan } from './chain-allocation';
import type { NativeWaypoint } from './native-route-plan';

const fuelPercents = [1, ...autoFuelGrid().map(fuel => Math.round(fuel * 100))];

async function waitForBtf<T>(read: () => T | undefined, signal: AbortSignal, message: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(60);
  }
  throw new Error(message);
}

function sliderFor(
  anchor: Element,
  field: 'fuelUsage' | 'reactorUsage' | 'payload',
  labels: string[],
) {
  const localized = getI18nValue(`BlueprintTestFlight.label.${field}`);
  return findFormSlider(anchor, localized === undefined ? labels : [localized, ...labels]);
}

function currentPlan(anchor: Element, previousId?: string) {
  const table = _$(anchor, C.MissionPlan.table);
  const id = (table instanceof HTMLElement ? getPrunId(table) : null) ?? previousId;
  return id === undefined ? undefined : flightPlansStore.getById(id);
}

async function waitForPlan(
  anchor: Element,
  previous: PrunApi.FlightPlan | undefined,
  from: string,
  to: string,
  signal: AbortSignal,
  allowEmptyFailure = false,
) {
  let seen: PrunApi.FlightPlan | undefined;
  let since = 0;
  const settleMs = allowEmptyFailure ? 300 : 1000;
  return await waitForBtf(
    () => {
      const plan = currentPlan(anchor, previous?.missionId);
      if (plan !== seen) {
        seen = plan;
        since = Date.now();
      }
      if (plan === undefined || plan === previous || Date.now() - since < settleMs) {
        return undefined;
      }
      const origin = getEntityNaturalIdFromAddress(plan.segments[0]?.origin);
      const destination = getEntityNaturalIdFromAddress(plan.segments.at(-1)?.destination);
      const matches =
        origin?.toUpperCase() === from.toUpperCase() &&
        destination?.toUpperCase() === to.toUpperCase();
      return matches || (allowEmptyFailure && plan.status !== 'OK' && plan.segments.length === 0)
        ? plan
        : undefined;
    },
    signal,
    `BTF 未返回 ${from} → ${to} 的新试飞结果。`,
  );
}

async function selectBtfAddress(field: Element, location: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const input = _$(field, C.AddressSelector.input);
  if (input instanceof HTMLInputElement && input.value !== '') {
    changeInputValue(input, '');
    await sleep(0);
  }
  signal.throwIfAborted();
  if (!(await selectAddress(field, location, { allowPartial: false }))) {
    throw new Error(`BTF 无法选择 ${location}。`);
  }
}

async function setBtfValue(
  anchor: Element,
  slider: Element,
  value: number,
  current: PrunApi.FlightPlan,
  from: string,
  to: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (getSliderValue(slider) === value) {
    return current;
  }
  if (!(await setSliderValue(slider, value, { exactMaximum: true }))) {
    throw new Error(`BTF 无法将 ${from} → ${to} 的滑块设为 ${value}。`);
  }
  return await waitForPlan(anchor, current, from, to, signal, true);
}

export async function measureNativeRouteFuel(
  candidate: ShipChainPlan,
  waypoints: readonly NativeWaypoint[],
  signal: AbortSignal,
  onProgress: (status: string) => void,
) {
  const blueprint = candidate.ship.ship.blueprintNaturalId;
  if (!blueprint.trim()) {
    throw new Error('所选船只缺少对应的蓝图 ID。');
  }
  signal.throwIfAborted();
  const command = `BTF ${blueprint}`;
  const window = await showBuffer(command, { force: true });
  try {
    const anchor = await waitForBtf(
      () => {
        const panel = _$(window, C.TileFrame.anchor);
        const active = _$(window, C.TileFrame.cmd)?.textContent?.trim();
        return active === command &&
          panel !== undefined &&
          _$$(panel, C.AddressSelector.container).length === 2
          ? panel
          : undefined;
      },
      signal,
      `找不到蓝图 ${blueprint} 的 BTF 地址选择器。`,
    );
    const [origin, destination] = _$$(anchor, C.AddressSelector.container);
    const fuelPercentsByLeg: number[] = [];
    for (let index = 1; index < waypoints.length; index++) {
      const from = waypoints[index - 1]!.location;
      const to = waypoints[index]!.location;
      const previous = currentPlan(anchor);
      onProgress(`BTF ${blueprint} · ${index}/${waypoints.length - 1} · ${from} → ${to}`);
      await selectBtfAddress(origin!, from, signal);
      await selectBtfAddress(destination!, to, signal);
      let plan = await waitForPlan(anchor, previous, from, to, signal);

      const payload = sliderFor(anchor, 'payload', [
        'Inventory',
        'Payload',
        '库存',
        '载荷',
        '载重',
      ]);
      if (payload === undefined) {
        throw new Error('找不到 BTF 的载重滑块。');
      }
      const plannedWeight =
        index === 1
          ? candidate.plan.loadOnDeparture.weight
          : index === waypoints.length - 1
            ? candidate.plan.loadOnReturn.weight
            : candidate.plan.stops[index - 2]!.loadOnDeparture.weight;
      const weight = Math.ceil((candidate.ship.cargoStore?.weightLoad ?? 0) + plannedWeight);
      const payloadRange = getSliderRange(payload);
      if (
        !Number.isFinite(weight) ||
        payloadRange === undefined ||
        weight < payloadRange.min ||
        weight > payloadRange.max
      ) {
        throw new Error(`${from} → ${to} 的计划载重 ${weight}t 超出蓝图试飞范围。`);
      }
      plan = await setBtfValue(anchor, payload, weight, plan, from, to, signal);

      const reactor = sliderFor(anchor, 'reactorUsage', ['Reactor usage', '反应堆使用量']);
      const reactorRange = reactor === undefined ? undefined : getSliderRange(reactor);
      if (
        reactor !== undefined &&
        reactorRange !== undefined &&
        !reactor.classList.contains('rc-slider-disabled')
      ) {
        const value = Math.max(reactorRange.min, Math.min(50, reactorRange.max));
        plan = await setBtfValue(anchor, reactor, value, plan, from, to, signal);
      }
      const reactorPercent = reactor === undefined ? 50 : (getSliderValue(reactor) ?? 50);
      const samples: FuelTradeoff[] = [];
      for (const percent of fuelPercents) {
        if (!anchor.isConnected || _$(window, C.TileFrame.cmd)?.textContent?.trim() !== command) {
          throw new Error('BTF 窗口已关闭或切换。');
        }
        const fuel = sliderFor(anchor, 'fuelUsage', ['Fuel usage', '燃料消耗']);
        if (fuel === undefined) {
          throw new Error('找不到 BTF 的燃料消耗滑块。');
        }
        onProgress(
          `BTF ${blueprint} · ${index}/${waypoints.length - 1} · ${from} → ${to} · ${percent}%`,
        );
        plan = await setBtfValue(anchor, fuel, percent, plan, from, to, signal);
        if (plan.status !== 'OK') {
          continue;
        }
        const measured = summarizeNativeFlightPlan(plan);
        if (measured.totalSeconds > 0) {
          samples.push({
            fuel: percent,
            reactor: reactorPercent,
            totalHours: measured.totalSeconds / 3600,
            stlFuel: measured.stlFuel,
            ftlFuel: measured.ftlFuel,
          });
        }
      }
      const best = findBalanceOption(samples);
      if (best === undefined) {
        throw new Error(`${from} → ${to} 的 BTF 试飞没有可用方案。`);
      }
      fuelPercentsByLeg.push(best.fuel);
    }
    return fuelPercentsByLeg;
  } finally {
    closePrunWindow(window);
  }
}
