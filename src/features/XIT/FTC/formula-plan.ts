// 单段航线的一次公式规划：把「停靠船 + 起终点 + 油量/载重 + 时刻」收敛成一套方案，
// 供 SFC 自动联动（写滑块）与 FLEET（环线时长、原生航点档位）共用。
//
// 与 XIT FTC 面板的关系：面板自己持有玩家输入（蓝图/载重/余油/时刻），直接调
// formula-options.calculateFormulaOptions；本模块是同一函数在「无面板、后台」场景下的入口，
// 输入来自 store（ships / blueprints / orbit / routes / planet-environment）。
//
// 判缺口径：几何、环境或星图不全时**返回 inputIncomplete 而不是退化数值** ——
// SFC 按此跳过滑块写入（宁可不动，也不写错值），FLEET 按此标缺。
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { stlFuelMassPerUnit } from '@src/core/flight/stl';
import { FlightFuelError, FlightInputError } from '@src/infrastructure/fio/flight-formula';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { gameNow } from '@src/infrastructure/fio/orbit';
import { sleep } from '@src/utils/sleep';
import type {
  FlightBlueprint,
  FlightRequest,
  FormulaFlight,
} from '@src/infrastructure/fio/flight-formula';
import { loadFormulaInputs } from './formula-inputs';
import {
  calculateFormulaOptions,
  type FormulaOption,
  type FormulaPrices,
  type FormulaSelection,
} from './formula-options';
import { shipFuelRemainingFor } from './ship-fuel';

export interface FormulaPlanRequest {
  ship: PrunApi.Ship;
  // 起终点实体（naturalId，如 HRT / VH-331g）。
  from: string;
  to: string;
  useGateway: boolean;
  // 出发时刻（游戏世界时间）；缺省当前游戏时刻。
  atMs?: number;
  // 规划载重（t）。缺省按飞船当前质量反推（含已装货）。
  payload?: number;
  // 出发时两类油缸余量（u）。缺省读油罐 store 实测。
  stlFuel?: number;
  ftlFuel?: number;
  // 固定档位：给定 fuel 时不扫网格，只算这一档（反应堆缺省取与燃料档同口径的 0.5）。
  fuel?: number;
  reactor?: number;
  prices?: Partial<FormulaPrices>;
  // 'value' 仅用于原生 RT：按整数档在油量足够的方案中选性价比档。
  selection?: FormulaSelection;
}

export interface FormulaPlan {
  ok: boolean;
  message: string;
  // 非空 = 输入缺失，方案不可信：SFC 不得写滑块，FLEET 按缺项显示。
  inputIncomplete?: string[];
  insufficientFuel?: boolean;
  best?: FormulaOption;
  options?: FormulaOption[];
  request?: FlightRequest;
  route?: FormulaFlight['route'];
  reactorRelevant: boolean;
  remaining?: { stlRemaining: number; ftlRemaining: number; stlCap: number; ftlCap: number };
}

// 蓝图可能还没到：blueprintsStore 只含已加载的公司蓝图，首次访问会触发 BLU 请求。
// 与旧 ftc-compute.ensureShipBlueprint 同口径：等最多 6 s。失败按「缺飞船蓝图」判缺，
// 并记一次 60 s 的负缓存，避免 FLEET 多段估算每段都白等 6 s。
const BLUEPRINT_WAIT_MS = 6000;
const BLUEPRINT_MISS_TTL_MS = 60_000;
const blueprintMisses = new Map<string, number>();

async function blueprintOf(ship: PrunApi.Ship): Promise<FlightBlueprint | undefined> {
  const id = ship.blueprintNaturalId;
  // blueprintsStore 的蓝图结构与 FlightBlueprint 逐字段一致（面板同样直接使用）。
  const loaded = blueprintsStore.getByNaturalId(id) as unknown as FlightBlueprint | undefined;
  if (loaded !== undefined) {
    return loaded;
  }
  const missedAt = blueprintMisses.get(id);
  if (missedAt !== undefined && Date.now() - missedAt < BLUEPRINT_MISS_TTL_MS) {
    return undefined;
  }
  const deadline = Date.now() + BLUEPRINT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    const value = blueprintsStore.getByNaturalId(id) as unknown as FlightBlueprint | undefined;
    if (value !== undefined) {
      blueprintMisses.delete(id);
      return value;
    }
  }
  blueprintMisses.set(id, Date.now());
  return undefined;
}

// 飞船当前质量减去空重与两类燃料重量 = 已装货重量（t）。
function payloadOf(ship: PrunApi.Ship, stlFuel: number, ftlFuel: number, ftlWeight: number) {
  const fuelMass = stlFuelMassPerUnit * stlFuel + ftlWeight * ftlFuel;
  return Math.max(0, ship.mass - ship.operatingEmptyMass - fuelMass);
}

export async function planFormulaFlight(input: FormulaPlanRequest): Promise<FormulaPlan> {
  const { ship, from, to } = input;
  const atMs = input.atMs ?? gameNow();
  const blueprint = await blueprintOf(ship);
  if (blueprint === undefined) {
    return {
      ok: false,
      message: '缺少飞船蓝图数据（先在 BLU 打开蓝图列表；非本公司蓝图无法用于计算）',
      inputIncomplete: ['飞船蓝图'],
      reactorRelevant: false,
    };
  }
  const remaining = shipFuelRemainingFor(ship);
  const stlKnown = input.stlFuel !== undefined || remaining.stlCap > 0;
  const ftlKnown = input.ftlFuel !== undefined || remaining.ftlCap > 0;
  const stlFuel = input.stlFuel ?? (remaining.stlCap > 0 ? remaining.stlRemaining : 0);
  const ftlFuel = input.ftlFuel ?? (remaining.ftlCap > 0 ? remaining.ftlRemaining : 0);
  const ftlWeight = blueprint.performance.ftlFuelMaterial?.weight ?? 0;
  const payload = input.payload ?? payloadOf(ship, stlFuel, ftlFuel, ftlWeight);
  let loaded;
  try {
    loaded = await loadFormulaInputs(from, to, input.useGateway);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      inputIncomplete: [error instanceof Error ? error.message : String(error)],
      reactorRelevant: false,
      remaining,
    };
  }
  const minReactor = blueprint.performance.minReactorUsage;
  const request: FlightRequest = {
    origin: loaded.origin,
    destination: loaded.destination,
    landing: true,
    payload,
    condition: ship.condition,
    stlFuel,
    ftlFuel,
    fuelUsageFactor: input.fuel ?? Math.max(minReactor, 0.5),
    reactorUsageFactor: input.reactor ?? Math.max(minReactor, 0.5),
    preferences: { useGateways: input.useGateway, ftlPreference: 'LEAST_JUMPS' },
  };
  const optimize = input.fuel === undefined;
  try {
    const { best, options } = calculateFormulaOptions(
      request,
      blueprint,
      loaded.input,
      atMs,
      { stl: input.prices?.stl, ftl: input.prices?.ftl, time: input.prices?.time ?? 0 },
      optimize,
      input.selection,
    );
    const insufficientFuel = input.selection === 'value' && !best.feasible;
    const unknownTanks = [
      best.stlShortage > 0 && !stlKnown ? 'STL 油箱数据' : undefined,
      best.ftlShortage > 0 && !ftlKnown ? 'FTL 油箱数据' : undefined,
    ].filter(x => x !== undefined);
    if (insufficientFuel && unknownTanks.length > 0) {
      return {
        ok: false,
        message: `缺少${unknownTanks.join('、')}，无法核对出发余油。`,
        inputIncomplete: unknownTanks,
        reactorRelevant: best.reactorRelevant,
        remaining,
      };
    }
    const shortages = [
      best.stlShortage > 0 ? `STL 缺 ${Math.ceil(best.stlShortage)} u` : undefined,
      best.ftlShortage > 0 ? `FTL 缺 ${Math.ceil(best.ftlShortage)} u` : undefined,
    ].filter(x => x !== undefined);
    return {
      ok: !insufficientFuel,
      message: insufficientFuel ? `已扫描的档位均油量不足（${shortages.join('、')}）。` : '',
      insufficientFuel,
      best,
      options,
      request: { ...request, origin: loaded.origin, destination: loaded.destination },
      route: best.route,
      reactorRelevant: best.reactorRelevant,
      remaining,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.selection === 'value' && error instanceof FlightFuelError) {
      if (!stlKnown) {
        return {
          ok: false,
          message: '缺少 STL 油箱数据，无法核对出发余油。',
          inputIncomplete: ['STL 油箱数据'],
          reactorRelevant: false,
          remaining,
        };
      }
      return { ok: false, message, insufficientFuel: true, reactorRelevant: false, remaining };
    }
    if (error instanceof FlightInputError) {
      return { ok: false, message, inputIncomplete: [message], reactorRelevant: false, remaining };
    }
    // 编程错误不是「缺输入」：不能让它变成 inputIncomplete，否则 SFC 静默跳过、FLEET 标缺，
    // 真正的 bug 就没人看见。这里如实报告失败并留一条控制台记录。
    console.error('[rprun] planFormulaFlight 计算失败', error);
    return { ok: false, message: `公式计算失败：${message}`, reactorRelevant: false, remaining };
  }
}

// SFC 联动按船注册号调用（面板/动作只持有 registration）。
export async function planFormulaFlightForRegistration(
  input: Omit<FormulaPlanRequest, 'ship'> & { shipRegistration: string },
): Promise<FormulaPlan> {
  const ship = shipsStore.getByRegistration(input.shipRegistration);
  if (ship === undefined) {
    return {
      ok: false,
      message: '请选择停靠中的飞船',
      inputIncomplete: ['停靠中的飞船'],
      reactorRelevant: false,
    };
  }
  const rest: FormulaPlanRequest = { ...input, ship };
  return planFormulaFlight(rest);
}
