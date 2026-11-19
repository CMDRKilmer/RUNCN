// 环线各段预计飞行时间（XIT FLEET 环线）。
//
// 每段时长 = 该段在新公式模型下的最优方案时长（`predictFormulaFlight`，与 XIT FTC 面板
// 同一模块、同一选点口径：设了时间价值 → 燃料+时间成本最优；未设 → Pareto 平衡点）。
// 航线几何、起降距离与天体位置全部由模型按出发时刻推算，**不再依赖服务器原生 STL 段记录**，
// 也不再需要旧的自建弧形近似（`transfer-geometry.ts` 的均值圆弧）—— 那两条路径随本次切换
// 一并停用。
//
// 时刻口径：每段出发时刻 = 起点时刻 + 前序各段飞行时长累计（供面板显示到达时刻与到港预测）。
// 注意：这里只估算"飞行"时长，不包含各站的卸货/提取停留时间。
// 逐段状态按规格（26-11-14 重测）递推：每段用**该段离站载重**与**上一段到达后的剩余油量**
// 计算，不再按「当前油量 + 当前质量」重复估算——新公式的转移速度取决于出发余油与总重，
// 不递推会把装载后的后续航段算得偏快、把低油量船算得偏慢。
// 出发油量默认取罐容量：环线在出发地补满（原生 RT 默认写补满步骤，ACT 路径由独立加油
// 触发器处理），由 `refuelAtOrigin: false` 可改回「按当前余量出发」。
//
// 判缺：缺少轨道/环境/星图数据，或航线不可达时，该段 ok = false 并给出成因全文
// （`formula-plan` 返回的 inputIncomplete），面板显示「--（成因）」，不会把缺数据写成 0 小时。
import { gameNow } from '@src/infrastructure/fio/orbit';
import { planFormulaFlight } from '@src/features/XIT/FTC/formula-plan';
import { shipFuelRemainingFor } from '@src/features/XIT/FTC/ship-fuel';

/** 环线的一个航段：从 `from` 到 `to` 的预计飞行。 */
export interface ChainFlightLeg {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  // 是否成功算出时长（无航线/模型输入残缺时为 false）。
  ok: boolean;
  error?: string;
  // 输入残缺时的**成因全文**（中文，来自 formula-plan），供面板 tooltip 展示。
  // 此时 ok = false、hours = 0。
  missingInputs?: string[];
  // 预计飞行时长（小时，= 该段最优方案总时长）。
  hours: number;
  // 预计出发/到达时刻（毫秒，游戏世界时间）。
  departAtMs: number;
  arriveAtMs: number;
  // 该段油耗（出发油量 − 到达余量），供循环每轮 SF/FF 账单；缺油量数据时 undefined。
  stlUsed?: number;
  ftlUsed?: number;
}

/** 一条环线（一艘船）的各段飞行时间预估。 */
export interface ChainFlightEstimate {
  ok: boolean;
  shipRegistration: string;
  legs: ChainFlightLeg[];
  // 各段飞行时长合计（小时；只累加 ok 段 —— 判缺段按 0 计，由 ok = false 标出）。
  totalHours: number;
  endpointHours?: { outbound: (number | undefined)[]; inbound: (number | undefined)[] };
}

export interface ChainFlightTimeInput {
  ship: PrunApi.Ship;
  // 出发地 naturalId（环线起点，也是归航终点）。
  origin: string;
  // 按到访顺序排列的站点。
  stops: { naturalId: string; planetName: string }[];
  // 起始时刻（毫秒，游戏世界时间）；缺省为当前游戏时刻。
  startAtMs?: number;
  // Sample each possible segment endpoint for multi-ship allocation.
  includeEndpointHours?: boolean;
  // 每段离站载重（t），与航段一一对应：`[起点→站0, 站0→站1, …, 末站→起点]`。
  // 缺省项由模型按飞船当前质量反推（含船上现有货物）。
  legPayloads?: readonly (number | undefined)[];
  // 出发地补满油罐（缺省 true）：首段按罐容量出发，后续段按上一段剩余量递推。
  refuelAtOrigin?: boolean;
  // 价格（可选；0 时平衡点不依赖价格）。
  stlPrice?: number;
  ftlPrice?: number;
  timeValue?: number;
  // 是否走网关航线（缺省 false：环线实际用自然航线飞行）。
  useGateway?: boolean;
}

interface LegFuel {
  stl: number | undefined;
  ftl: number | undefined;
}

// 出发油量：默认按补满后的罐容量，否则按当前余量。容量读不出（store 未加载）时保持
// undefined，交给公式模型自己判缺，而不是假装有油。余量 0 是真空罐，必须原样保留。
function departureFuel(ship: PrunApi.Ship, refuelAtOrigin: boolean): LegFuel {
  const fuel = shipFuelRemainingFor(ship);
  const pick = (cap: number, remaining: number) =>
    cap > 0 ? (refuelAtOrigin ? cap : remaining) : undefined;
  return {
    stl: pick(fuel.stlCap, fuel.stlRemaining),
    ftl: pick(fuel.ftlCap, fuel.ftlRemaining),
  };
}

// 船当前油罐容量（units）。FLEET 取油罐口径的唯一出口：本模块已经把 XIT FTC 的燃料模型借过来
// （planFormulaFlight / shipFuelRemainingFor），面板及其子组件不必再直接引用另一个 feature。
export function chainShipFuelCaps(ship: PrunApi.Ship): { stlCap: number; ftlCap: number } {
  const fuel = shipFuelRemainingFor(ship);
  return { stlCap: fuel.stlCap, ftlCap: fuel.ftlCap };
}

// 计算一条环线各段的预计飞行时间（按到访顺序逐段累计）。
export async function estimateChainFlightTimes(
  input: ChainFlightTimeInput,
): Promise<ChainFlightEstimate> {
  const { ship, origin, stops } = input;
  const startAtMs = input.startAtMs ?? gameNow();
  const prices = {
    stl: input.stlPrice ?? 0,
    ftl: input.ftlPrice ?? 0,
    time: input.timeValue ?? 0,
  };
  const useGateway = input.useGateway ?? false;

  const nameOf = new Map<string, string>();
  nameOf.set(origin.toUpperCase(), origin);
  for (const stop of stops) {
    nameOf.set(stop.naturalId.toUpperCase(), stop.planetName || stop.naturalId);
  }
  const nodeName = (id: string) => nameOf.get(id.toUpperCase()) ?? id;

  async function estimateLeg(
    from: string,
    to: string,
    departAtMs: number,
    legIndex: number,
    fuel: LegFuel,
  ): Promise<{ leg: ChainFlightLeg; remaining?: LegFuel }> {
    const leg: ChainFlightLeg = {
      from,
      to,
      fromName: nodeName(from),
      toName: nodeName(to),
      ok: false,
      hours: 0,
      departAtMs,
      arriveAtMs: departAtMs,
    };
    // 起点与终点相同（如站点重复/归航即出发地）：无航程。
    if (from.toUpperCase() === to.toUpperCase()) {
      leg.ok = true;
      leg.stlUsed = 0;
      leg.ftlUsed = 0;
      return { leg };
    }
    const payload = input.legPayloads?.[legIndex];
    const plan = await planFormulaFlight({
      ship,
      from,
      to,
      useGateway,
      atMs: departAtMs,
      prices,
      selection: 'balance',
      ...(payload === undefined ? {} : { payload }),
      ...(fuel.stl === undefined ? {} : { stlFuel: fuel.stl }),
      ...(fuel.ftl === undefined ? {} : { ftlFuel: fuel.ftl }),
    });
    if (!plan.ok || plan.best === undefined) {
      const items = plan.inputIncomplete ?? [];
      leg.missingInputs = items.length > 0 ? items : undefined;
      leg.error = items.length > 0 ? '缺规划输入' : plan.message;
      return { leg };
    }
    const hours = plan.best.totalHours;
    if (!(Number.isFinite(hours) && hours > 0)) {
      leg.error = '飞行时长为 0（检查起终点与油量）';
      return { leg };
    }
    leg.ok = true;
    leg.hours = hours;
    leg.arriveAtMs = departAtMs + hours * 3600000;
    // 下一段按到达后的余量起飞（新公式的转移速度取决于出发余油）。
    // 不足时保留 0（而不是回退成满罐）——后续段会如实判缺，不会伪造一箱不存在的油。
    const remaining: LegFuel = {
      stl: Number.isFinite(plan.best.stlRemaining) ? Math.max(0, plan.best.stlRemaining) : fuel.stl,
      ftl: Number.isFinite(plan.best.ftlRemaining) ? Math.max(0, plan.best.ftlRemaining) : fuel.ftl,
    };
    // 逐段油耗 = 出发油量 − 到达余量；任一端不可读时留 undefined，由账单侧回退罐容量。
    if (typeof fuel.stl === 'number' && Number.isFinite(plan.best.stlRemaining)) {
      leg.stlUsed = Math.max(0, fuel.stl - Math.max(0, plan.best.stlRemaining));
    }
    if (typeof fuel.ftl === 'number' && Number.isFinite(plan.best.ftlRemaining)) {
      leg.ftlUsed = Math.max(0, fuel.ftl - Math.max(0, plan.best.ftlRemaining));
    }
    return { leg, remaining };
  }

  // 环线起点油量：默认补满，后续段按上一段剩余递推。
  const initialFuel = departureFuel(ship, input.refuelAtOrigin ?? true);

  const legs: ChainFlightLeg[] = [];
  let departAtMs = startAtMs;
  let fuel = initialFuel;
  for (let i = 0; i <= stops.length; i++) {
    const from = i === 0 ? origin : stops[i - 1]!.naturalId;
    const to = i === stops.length ? origin : stops[i]!.naturalId;
    const result = await estimateLeg(from, to, departAtMs, i, fuel);
    legs.push(result.leg);
    departAtMs = result.leg.arriveAtMs;
    if (result.remaining !== undefined) {
      fuel = result.remaining;
    }
  }

  let endpointHours: ChainFlightEstimate['endpointHours'];
  if (input.includeEndpointHours) {
    endpointHours = { outbound: [], inbound: [] };
    for (const [index, stop] of stops.entries()) {
      // 端点采样是假设性分段（从出发地直飞该站/从该站直飞出发地），都按起始油量与
      // 该站对应航段的载重计算，不继承主环线前面的消耗。
      const out =
        index === 0
          ? legs[0]!
          : (await estimateLeg(origin, stop.naturalId, startAtMs, index + 1, initialFuel)).leg;
      // Sample the return at direct arrival; the final assigned route recomputes its actual ETA.
      const back =
        stops.length === 1
          ? legs[1]!
          : (await estimateLeg(stop.naturalId, origin, out.arriveAtMs, index + 1, initialFuel)).leg;
      endpointHours.outbound.push(out.ok ? out.hours : undefined);
      endpointHours.inbound.push(back.ok ? back.hours : undefined);
    }
  }

  const totalHours = legs.reduce((sum, l) => sum + (l.ok ? l.hours : 0), 0);
  return {
    // est.ok 语义不变：所有段都算出来了；有判缺段时 ok = false。
    ok: legs.every(l => l.ok),
    shipRegistration: ship.registration,
    legs,
    totalHours,
    ...(endpointHours !== undefined ? { endpointHours } : {}),
  };
}
