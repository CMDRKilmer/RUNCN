// 环线各段预计飞行时间（XIT FLEET 环线）。
//
// 为环线的每一段（出发地→第1站、站→站、末站→归航）计算飞船预计飞行时间：
// - 飞行时间使用 FTC 的最优燃油计划（fuel-model 扫描 + 平衡点，与 FTC 面板一致）；
// - 每段出发时刻 = 起点时刻 + 前序各段飞行时长累计（供面板显示到达时刻与到港预测）；
// - STL 几何只取服务器原生记录、与时刻无关（见 route-planner.routeMetrics）：几何缺失的段
//   显式判缺（ok = false + missingInputs 成因全文）。⚠️ 旧注释曾写「下游基地用未来预计位置
//   预测天体位置算起降距离」——那是已删除的自建轨道模型（两轮重算几何）的行为，现已作废。
//
// 唯一例外是**环线预估**在系内航线缺前向记录时可用**几何预测**近似（显式标注，
// 见 predictTransferGeometry）：弧长 = 均值圆弧（r_mid × Δθ，**初版**，待 prun-log.json
// TRANSIT 段样本到位后用真实椭圆弧长重新标定）+ 时长 = d / (stlIntraTransitSpeedKmS(质量)
// / 状况)。速度口径 = fuel-model.ts 的 BTF 实测「参考速度 + 质量幂律」
// （VH-331g → HRT 599M km / 21,780s ≈ 27,512 km/s，船质量 1,271t；重船按 (1271/m)^0.78 减速）。
// ⚠️ 2026-09-24 之前「A+C」路径中的 C（反方向原生记录近似，见旧版
// reverseTransitApproximation）已被本公式路线（transfer-geometry.ts）一次性替代 ——
// 反方向记录相位与本段出发时刻不对齐、依赖同星系表精确键、且补不了罐容量 / STL 段速
// 模型缺失这 4 个旧限制全部消失，几何预测不依赖任何同星系表记录、且与本段出发时刻对齐
// （避免定点迭代耦合）。**近似不得用于写玩家滑块**：FTC 路径
// （ftc-compute.computeFtcPlan / SFC 联动）仍按 missingModelInputs 严格判缺、宁可不写
// （2026-09-23 用户拍板不变）。
//
// 与 FTC 面板共享同一套性能/航线/燃料模型，结果口径一致（balance 方案总时长）。
// 注意：这里只估算"飞行"时长，不包含各站的卸货/提取停留时间。

import { planRoutes, routeMetrics } from '@src/features/XIT/FTC/route-planner';
import type { PlannedRoute } from '@src/features/XIT/FTC/route-planner';
import {
  scanFuelOptions,
  autoFuelGrid,
  autoReactorGrid,
  findBalanceOption,
  missingModelInputs,
  conditionFactor,
} from '@src/features/XIT/FTC/fuel-model';
import type { FuelOption, ShipPerformance } from '@src/features/XIT/FTC/fuel-model';
import {
  ensureShipBlueprint,
  fetchPlanetEnv,
  shipPerformanceFor,
} from '@src/features/XIT/FTC/ftc-compute';
import { gameNow } from '@src/infrastructure/fio/orbit';
// 系内航线缺前向几何时，几何预测的唯一入口（见 transfer-geometry.ts 的文件头说明）。
// 用 @src/... 别名与同文件其它 FTC 导入保持一致（FLEET → FTC 的目录穿越用别名更直观）。
import { predictTransferGeometry } from '@src/features/XIT/FTC/transfer-geometry';
// 空间站 naturalId → 星系 id 解析（系内航段的恒星中心位置查询要用）。
import { resolveSystemId } from '@src/features/XIT/FTC/route-model';

// 时长来自**几何预测**的来源标注（transfer-geometry.ts 的均值圆弧初版）：
// 面板据此告诉玩家这段时长是近似值（不是原生前向记录），且不会因同星系表空表而失效。
// 不再保留「反方向记录」字面值（旧 C 路径已删），避免死代码迷惑后续维护者。

/** 环线的一个航段：从 `from` 到 `to` 的预计飞行。 */
export interface ChainFlightLeg {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  // 是否成功算出时长（无航线/无有效滑块组合/模型必需输入残缺时为 false）。
  ok: boolean;
  error?: string;
  // 输入残缺时的**成因全文**（中文，来自 fuel-model.missingModelInputs），供面板 title 展示。
  // 此时 ok = false、error = '缺原生 STL 段记录'、hours = 0。
  missingInputs?: string[];
  // 时长来自**几何预测**（transfer-geometry.ts 的均值圆弧初版），非原生前向记录。
  approximated?: {
    kind: 'predicted';
    // 输入 naturalId（HRT/VH-331g 这类；与 from/to 同；容错时可能是 fromLookup/toLookup）。
    from: string;
    to: string;
    distanceKm: number;
  };
  // 该段航线（自然/网关）与指标。
  route?: PlannedRoute;
  metrics?: ReturnType<typeof routeMetrics>;
  // 该段 FTC 最优方案（平衡点；设了时间价值时为总成本最优）。
  option?: FuelOption;
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
  // 其中借**几何预测**出时长的段数（> 0 时汇总文案须标注「近似」）。
  // 来源标注见 ChainFlightLeg.approximated.kind === 'predicted'（transfer-geometry.ts）。
  approximatedLegs: number;
}

export interface ChainFlightTimeInput {
  ship: PrunApi.Ship;
  // 出发地 naturalId（环线起点，也是归航终点）。
  origin: string;
  // 按到访顺序排列的站点。
  stops: { naturalId: string; planetName: string }[];
  // 起始时刻（毫秒，游戏世界时间）；缺省为当前游戏时刻。
  startAtMs?: number;
  // 价格（可选；0 时平衡点不依赖价格）。
  stlPrice?: number;
  ftlPrice?: number;
  timeValue?: number;
  // 是否走网关航线（缺省 false：环线实际用自然航线飞行）。
  useGateway?: boolean;
}

// 单个航段的 FTC 最优方案：与 FTC 面板同一逻辑——自动扫描燃料滑块 f
// （0.05→1 步长 0.05）；仅在存在自然跃迁时扫描反应堆 r（全程系内/纯网关
// 无自然跃迁，反应堆不影响时长与燃料，网格固定为 [1]）。
// 最优 = 平衡点：设了时间价值（₳/小时）时按总成本（燃料费+时间价值）最优，
// 未设时用 findBalanceOption 的 Pareto 拐点（与 FTC 面板完全一致）。
async function bestOptionFor(
  perf: ShipPerformance,
  metrics: ReturnType<typeof routeMetrics>,
  prices: { stlPrice: number; ftlPrice: number; timeValue: number },
): Promise<FuelOption | undefined> {
  // 跨星系航线的起/终点行星环境（内置 JSON）：着陆/起飞燃料影响总燃料，
  // 进而影响平衡点选择（对飞行时长影响很小，但保持与 FTC 面板口径一致）。
  const isCross = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const [landingEnv, departEnv] = await Promise.all([
    isCross && metrics.toBody !== undefined ? fetchPlanetEnv(metrics.toBody) : undefined,
    isCross && metrics.fromBody !== undefined ? fetchPlanetEnv(metrics.fromBody) : undefined,
  ]);
  const reactorRelevant = (metrics.natPc ?? 0) > 0 || (metrics.natJumpCount ?? 0) > 0;
  const options = scanFuelOptions(
    perf,
    metrics,
    autoFuelGrid(),
    reactorRelevant ? autoReactorGrid(perf) : [1],
    prices,
    {
      landingRadius: landingEnv?.radiusKm,
      landingPressure: landingEnv?.pressure,
      departureRadius: departEnv?.radiusKm,
      departurePressure: departEnv?.pressure,
    },
  );
  if (options.length === 0) {
    return undefined;
  }
  const tv = prices.timeValue;
  return tv > 0 ? options[0] : (findBalanceOption(options) ?? options[0]);
}

// 计算一条环线各段的预计飞行时间（按到访顺序逐段累计）。
export async function estimateChainFlightTimes(
  input: ChainFlightTimeInput,
): Promise<ChainFlightEstimate> {
  const { ship, origin, stops } = input;
  const startAtMs = input.startAtMs ?? gameNow();

  const prices = {
    stlPrice: input.stlPrice ?? 0,
    ftlPrice: input.ftlPrice ?? 0,
    timeValue: input.timeValue ?? 0,
  };
  const useGateway = input.useGateway ?? false;

  // 计算前确保飞船蓝图加载（决定 FTL 航速/充能/燃料罐/STL 引擎/最大 G 等性能）。
  await ensureShipBlueprint(ship);
  const perf = shipPerformanceFor(ship);

  const nameOf = new Map<string, string>();
  nameOf.set(origin.toUpperCase(), origin);
  for (const stop of stops) {
    nameOf.set(stop.naturalId.toUpperCase(), stop.planetName || stop.naturalId);
  }
  const nodeName = (id: string) => nameOf.get(id.toUpperCase()) ?? id;

  const legs: ChainFlightLeg[] = [];
  let elapsedMs = 0;
  for (let i = 0; i <= stops.length; i++) {
    const from = i === 0 ? origin : stops[i - 1]!.naturalId;
    const to = i === stops.length ? origin : stops[i]!.naturalId;
    const departAtMs = startAtMs + elapsedMs;
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
      legs.push(leg);
      continue;
    }
    try {
      const planned = planRoutes(from, to);
      const route = useGateway ? (planned.gateway ?? planned.natural) : planned.natural;
      if (!route) {
        leg.error = '航线不可达（需恒星位置数据）';
        legs.push(leg);
        continue;
      }
      // STL 起降几何只取服务器原生记录，与时刻无关（自建轨道模型回退已删除），
      // 故一轮计算即可 —— 旧实现按预测到达时刻重算第二轮几何，现已无意义。
      const metrics = routeMetrics(route);
      // 模型必需输入（fuel-model.missingModelInputs）：**先判缺、再算方案**。
      // ⚠️ 为什么单看「有没有 option」不够（本函数 2026-09-24 修的 bug）：
      // 几何缺失时 computeFuelOption 不报错，它只是把 metrics.stlDistanceKm 当 0 →
      // totalKm = 0 → stlHours = 0；系内航线又没有自然跃迁（natPc/gwPc = 0）⟹
      // totalHours === 0，而 findBalanceOption 对「燃料/时间无梯度」的退化输入只会退到最省油端
      // （见 fuel-model 的退化保护注释），绝不报错。于是旧实现把这种 0 小时写成了 ok = true：
      // 面板「飞行」列被 formatFlightDuration(0) 显示为「--（与出发同一时刻到达）」、
      // 循环里的 elapsedMs 原地不动（后续段都在"出发时刻"算几何）、汇总只累加第 1 段，更糟的是
      // 多船时间均衡（chain-planner.planTimeBalancedSegments 的 complete 门 = 所有段 est.ok）与
      // 到港库存预测（chain-planner 的 arrivalHoursByNaturalId）都把这些 0 当真值消费。
      // 现在：输入残缺即显式判缺（ok = false + 成因全文），宁可面板写「缺原生 STL 段记录」。
      const missing = missingModelInputs(perf, metrics);
      // A1 几何预测三条件（替代旧 C 反方向记录近似）：
      //   ① route.legs.length === 0（系内航线 —— 跨星系用 pc 距离 + routeMetrics.stlDistanceKm）
      //   ② metrics.stlDistanceKm undefined 或 ≤ 0（前向几何缺失）
      //   ③ predictTransferGeometry(...) !== undefined（几何预测成功，由返回值判定）
      // 满足 ① + ② 才调预测；返回值 undefined 则放弃近似，走老 bestOptionFor 路径。
      let approximation: Awaited<ReturnType<typeof predictTransferGeometry>> = undefined;
      if (
        route.legs.length === 0 &&
        (metrics.stlDistanceKm === undefined || metrics.stlDistanceKm <= 0)
      ) {
        // naturalId 优先用 metrics.fromLookup/toLookup（route-planner 已做星系 id → 空间站
        // 反查）；无该分量时回退到原 from/to。轨道预测的输入 naturalId 应是**实体**（HRT /
        // VH-331g 这类），不是星系 id —— 反查后的键就是这个口径，与原 from/to 大多数时候
        // 一致、少数情况下更精确（输入被 SFC 规范化的场景）。
        const fromOrbitId = metrics.fromLookup ?? from;
        const toOrbitId = metrics.toLookup ?? to;
        approximation = await predictTransferGeometry({
          fromId: fromOrbitId,
          toId: toOrbitId,
          fromSystemId: resolveSystemId(fromOrbitId) ?? '',
          toSystemId: resolveSystemId(toOrbitId) ?? '',
          t0Ms: departAtMs,
          cond: conditionFactor(perf.condition),
          // 转移段速度随质量下降（`v = 27512 × (1271/质量)^0.78`）—— 质量来自
          // 本函数上面已算好的 perf（shipPerformanceFor），无需新增数据来源。
          massT: perf.mass,
        });
      }
      // 几何预测只补「整段路程 + 时长」，不补罐容量/余量 —— 仍要过 missingModelInputs。
      const usedMetrics =
        approximation === undefined || approximation.distanceKm === undefined
          ? metrics
          : {
              ...metrics,
              stlDistanceKm: approximation.distanceKm,
              transitKm: approximation.distanceKm,
            };
      // 几何预测补完后再判一次：罐容量/余量缺失仍判缺 —— 近似不得掩盖残缺（与旧 A 路径一致）。
      const unresolved =
        approximation === undefined ? missing : missingModelInputs(perf, usedMetrics);
      if (unresolved.length > 0) {
        leg.error = '缺原生 STL 段记录';
        leg.missingInputs = unresolved;
        leg.ok = false;
        leg.hours = 0;
        leg.arriveAtMs = departAtMs;
        legs.push(leg);
        continue;
      }
      // 系内几何预测段（approximation 有值 + hours 有值）→ **不调 bestOptionFor**。
      // 理由：系内航线真实段结构是单段 TRANSIT（feature-patterns.md 「系内「转移」段标定」
      // 条目实测 ZV-307a → ANT 单段 101,655,808 km，无 DEPARTURE/APPROACH 拆分），小时数
      // 直接用 approx.hours（已含 cond 校正的 d/v_转移）；bestOptionFor 含整条航线计算
      // （gatewayCost / 充能 / 段速拆分），对单段系内转移不适用。
      // 选 **A（纯 TRANSIT）** 而非 B（加 depart/approach）—— B 的 `departKm = sqrt(R1×P^-0.2)`
      // 是跨星系口径，对系内航线会过算（真实没有这两段）。偏差量级：本函数不参与写滑块，
      // 仅作面板预估；待 prun-log.json TRANSIT 段样本到位后用真实椭圆弧长重新标定。
      if (approximation !== undefined && approximation.hours !== undefined) {
        const hours = approximation.hours;
        leg.ok = true;
        leg.route = route;
        leg.metrics = usedMetrics;
        leg.approximated = {
          kind: 'predicted',
          from: metrics.fromLookup ?? from,
          to: metrics.toLookup ?? to,
          distanceKm: approximation.distanceKm!,
        };
        leg.hours = hours;
        leg.arriveAtMs = departAtMs + hours * 3600000;
        elapsedMs += hours * 3600000;
        legs.push(leg);
        continue;
      }
      // 非近似路径（段原有逻辑：bestOptionFor 算整段方案）。
      const option = await bestOptionFor(perf, usedMetrics, prices);
      if (!option) {
        leg.error = '未能生成有效滑块组合';
        legs.push(leg);
        continue;
      }
      const hours = option.totalHours;
      leg.ok = true;
      leg.route = route;
      leg.metrics = usedMetrics;
      leg.option = option;
      leg.hours = hours;
      leg.arriveAtMs = departAtMs + hours * 3600000;
      elapsedMs += hours * 3600000;
    } catch (e) {
      leg.error = e instanceof Error ? e.message : String(e);
    }
    legs.push(leg);
  }

  const totalHours = legs.reduce((sum, l) => sum + (l.ok ? l.hours : 0), 0);
  return {
    // est.ok 语义不变：所有段都算出来了（含近似段）；有判缺段时 ok = false。
    ok: legs.every(l => l.ok),
    shipRegistration: ship.registration,
    legs,
    totalHours,
    approximatedLegs: legs.filter(l => l.approximated !== undefined).length,
  };
}
