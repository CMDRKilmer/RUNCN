// SFC 自动联动的最优燃料方案（公式模型版）。
//
// 契约与 `ftc-compute.computeFtcPlan` 逐项一致，只是方案来自新公式模型
// （`formula-plan.planFormulaFlight`，与 XIT FTC 面板同一模块）：
// - 按**航线键**（船 + 起终点 + 网关标志）写入共享参数 `ftc-fuel-settings`，SFC 滑块自动跟随；
// - 写入 `lastFtcCompute`，供 OPEN_SFC / DEPART 等动作等待「本航线参数已就绪」；
// - 输入残缺（缺轨道/环境/星图、航线不可达）时**不写任何参数**，由调用方沿用玩家当前设置。
//
// 与旧实现的差别：不再需要服务器原生 STL 段记录 —— 几何由轨道数据推出，这是 SFC 联动最主要的
// 可用性改善。代价：结果尚未经「同一艘船连续两程不补油」的真机验证（仅单程实船对照，
// 见 scripts/verify-real-flight.mjs）。
import { ftcRouteKey, setFtcFuelSlider, setFtcReactorUsage } from './ftc-fuel-settings';
import { lastFtcCompute } from './ftc-compute';
import { planFormulaFlightForRegistration, type FormulaPlan } from './formula-plan';

export interface FormulaComputeInput {
  shipRegistration: string;
  from: string;
  to: string;
  useGateway?: boolean;
  // 只评估指定档位（0–1）：原生 RT 生成按实际写入的档位重算该档位的消耗与时长。
  fixedFuel?: number;
  fixedReactor?: number;
  // 规划出发时的 STL 罐余量（u）。缺省读油罐 store 实测。
  stlFuelOverride?: number;
  // 规划期的额外载重（t）：缺省用飞船当前载重（由当前质量反推）。
  extraMassT?: number;
  // 价格（可选；0 时按 Pareto 平衡点选点）。
  stlPrice?: number;
  ftlPrice?: number;
  timeValue?: number;
  // 是否把结果发布给 SFC（共享滑块参数 + lastFtcCompute 完成信号）。缺省 true。
  publish?: boolean;
}

export interface FormulaComputeOutput {
  ok: boolean;
  message: string;
  // 非空 = 模型输入残缺：`best` 未写入共享参数，SFC 联动须跳过滑块写入。
  inputIncomplete?: string[];
  best?: { fuel: number; reactor: number; totalHours: number; stlFuel: number; ftlFuel: number };
  reactorRelevant: boolean;
  plan?: FormulaPlan;
}

export async function computeFormulaFtcPlan(
  input: FormulaComputeInput,
): Promise<FormulaComputeOutput> {
  const from = input.from.trim();
  const to = input.to.trim();
  if (!from || !to) {
    return { ok: false, message: '请输入起点和终点', reactorRelevant: false };
  }
  if (from.toUpperCase() === to.toUpperCase()) {
    return {
      ok: false,
      message: '起点和终点不能是同一个实体；请选择实际出发地和目的地',
      reactorRelevant: false,
    };
  }
  const plan = await planFormulaFlightForRegistration({
    shipRegistration: input.shipRegistration,
    from,
    to,
    useGateway: input.useGateway === true,
    payload: input.extraMassT,
    stlFuel: input.stlFuelOverride,
    fuel: input.fixedFuel,
    reactor: input.fixedReactor,
    prices: { stl: input.stlPrice, ftl: input.ftlPrice, time: input.timeValue ?? 0 },
  });
  const best = plan.ok ? plan.best : undefined;
  const complete = best !== undefined && plan.inputIncomplete === undefined;
  const routeKey = ftcRouteKey(input.shipRegistration, from, to, input.useGateway === true);
  // 仅在输入完整时写入：残缺输入下方案不可信，写进去会覆盖玩家/面板刚设好的参数。
  const shareable = complete && best !== undefined && input.publish !== false;
  if (shareable) {
    setFtcFuelSlider(routeKey, best.fuel);
    setFtcReactorUsage(routeKey, best.reactor);
  }
  if (input.publish !== false) {
    lastFtcCompute.value = { key: routeKey, at: Date.now(), complete: shareable };
  }
  if (!complete || best === undefined) {
    const incomplete = plan.inputIncomplete;
    return {
      ok: plan.ok,
      message: incomplete === undefined ? plan.message : `⚠ 输入不完整：${incomplete.join('；')}`,
      inputIncomplete: incomplete,
      reactorRelevant: plan.reactorRelevant,
      plan,
    };
  }
  return {
    ok: true,
    message: '',
    best: {
      fuel: best.fuel,
      reactor: best.reactor,
      totalHours: best.totalHours,
      stlFuel: best.stlFuel,
      ftlFuel: best.ftlFuel,
    },
    reactorRelevant: plan.reactorRelevant,
    plan,
  };
}
