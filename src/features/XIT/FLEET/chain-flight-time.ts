// 环线各段预计飞行时间（XIT FLEET 环线）。
//
// 每段时长 = 该段在新公式模型下的最优方案时长（`predictFormulaFlight`，与 XIT FTC 面板
// 同一模块、同一选点口径：设了时间价值 → 燃料+时间成本最优；未设 → Pareto 平衡点）。
// 航线几何、起降距离与天体位置全部由模型按出发时刻推算，**不再依赖服务器原生 STL 段记录**，
// 也不再需要旧的自建弧形近似（`transfer-geometry.ts` 的均值圆弧）—— 那两条路径随本次切换
// 一并停用。
//
// 时刻口径：每段出发时刻 = 起点时刻 + 前序各段飞行时长累计（供面板显示到达时刻与到港预测）。
// 注意：这里只估算"飞行"时长，不包含各站的卸货/提取停留时间；模型按飞船**当前**油量与质量
// 逐段独立计算（不递推后续航段的耗油，与切换前的口径一致）。
//
// 判缺：缺少轨道/环境/星图数据，或航线不可达时，该段 ok = false 并给出成因全文
// （`formula-plan` 返回的 inputIncomplete），面板显示「--（成因）」，不会把缺数据写成 0 小时。
import { gameNow } from '@src/infrastructure/fio/orbit';
import { planFormulaFlight } from '@src/features/XIT/FTC/formula-plan';

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
  // 价格（可选；0 时平衡点不依赖价格）。
  stlPrice?: number;
  ftlPrice?: number;
  timeValue?: number;
  // 是否走网关航线（缺省 false：环线实际用自然航线飞行）。
  useGateway?: boolean;
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
  ): Promise<ChainFlightLeg> {
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
      return leg;
    }
    const plan = await planFormulaFlight({
      ship,
      from,
      to,
      useGateway,
      atMs: departAtMs,
      prices,
      selection: 'balance',
    });
    if (!plan.ok || plan.best === undefined) {
      const items = plan.inputIncomplete ?? [];
      leg.missingInputs = items.length > 0 ? items : undefined;
      leg.error = items.length > 0 ? '缺规划输入' : plan.message;
      return leg;
    }
    const hours = plan.best.totalHours;
    if (!(Number.isFinite(hours) && hours > 0)) {
      leg.error = '飞行时长为 0（检查起终点与油量）';
      return leg;
    }
    leg.ok = true;
    leg.hours = hours;
    leg.arriveAtMs = departAtMs + hours * 3600000;
    return leg;
  }

  const legs: ChainFlightLeg[] = [];
  let departAtMs = startAtMs;
  for (let i = 0; i <= stops.length; i++) {
    const from = i === 0 ? origin : stops[i - 1]!.naturalId;
    const to = i === stops.length ? origin : stops[i]!.naturalId;
    const leg = await estimateLeg(from, to, departAtMs);
    legs.push(leg);
    departAtMs = leg.arriveAtMs;
  }

  let endpointHours: ChainFlightEstimate['endpointHours'];
  if (input.includeEndpointHours) {
    endpointHours = { outbound: [], inbound: [] };
    for (const [index, stop] of stops.entries()) {
      const out = index === 0 ? legs[0]! : await estimateLeg(origin, stop.naturalId, startAtMs);
      // Sample the return at direct arrival; the final assigned route recomputes its actual ETA.
      const back =
        stops.length === 1 ? legs[1]! : await estimateLeg(stop.naturalId, origin, out.arriveAtMs);
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
