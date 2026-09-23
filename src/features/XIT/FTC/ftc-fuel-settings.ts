import { persistedRef } from '@src/utils/persisted-ref';

// FTC 最优燃料参数（燃料滑块 / 反应堆使用量）**按航线**键控的持久化 map。
// 键 = ftcRouteKey(ship, from, to, useGateway)，如 'AVI-06JVV|ZV-307A|ZV-307|nat'。
//
// 为什么从「按船」改成「按航线」（2026-09-23）：按船键控时一条船只有一个键 —— 船换了
// 目的地而新航线算不出来（无原生几何 → 门控不写参数）时，该键上还留着**上一条航线**的
// 值，SFC 打开新航线后面板照样读到这个值并写进新航线的滑块。值本身是合法的，只是属于
// 另一条航线 —— 这是与「脏值作废」完全独立的第二个错误写入面。键里带上起终点与网关
// 标志后不同航线互不可见 → 读不到就是 undefined → SFC 不改滑块（与既有的「残缺不写」
// 路径同一行为）。多船同时打开 SFC 面板仍互不覆盖：不同船/不同航线 = 不同键（原本按船
// 键控要解决的就是这个互相覆盖 + 反馈抖动问题，航线级键天然满足且更细）。
// 网关标志必须进键：同一对起终点的「直飞」与「使用跃迁点」是两种段结构（几何与反应堆
// 相关性都不同），最优参数不同，不能互借。
type RouteFtcValues = Record<string, number>;

// 航线键（与 ftc-compute.lastFtcCompute.key **同格式**，便于对照日志排查）。
// 起终点做 trim + 大写归一：SFC 输入框/地址实体大小写不稳定，而记录查表本身也不区分
// 大小写（stlSegmentsStore 全大写键控）—— 同一条航线必须始终映射到同一个键。
export function ftcRouteKey(ship: string, from: string, to: string, useGateway: boolean): string {
  const gateway = useGateway ? 'gw' : 'nat';
  return `${ship}|${from.trim().toUpperCase()}|${to.trim().toUpperCase()}|${gateway}`;
}

// ⚠️ key 版本 v3 → v4（键语义从「按船」变成「按航线」，**唯一**的作废手段）。
//
// 为什么必须作废 v3、不能迁移：v3 的键只有船 registration，值里没有任何字段能说明它属于
// 哪条航线 —— 不知道某个值该搬到哪个航线键下。也不能靠「合理性校验」筛出可迁移的项：
// `f = 1` 与 `r = 1` 都是**合法**取值（f = 1 是最快档，findBalanceOption 在极短航线上会
// 选它；同星系航线 reactorRelevant = false → 反应堆网格只有 r = 1），而 `.v3` 里没有记录
// 能表明某个值是哪条航线、哪次计算写的；且 persistedRef（src/utils/persisted-ref.ts）只做
// JSON.parse 恢复，**不支持** rename / 迁移钩子。与上一轮 v2 → v3 同理：一次性作废。
//
// 代价（可接受）：所有航线要重算一次（完整输入）才恢复自动写滑块；丢弃期间读取返回
// undefined → SFC 不改滑块、沿用玩家当前设置（与既有的「残缺不写」路径同一行为），
// 绝不会写出错值。
const fuelSliders = persistedRef<RouteFtcValues>('rprun.ftc.fuel-slider.v4', {});
const reactorUsages = persistedRef<RouteFtcValues>('rprun.ftc.reactor-usage.v4', {});

// 供 sfc-auto-fuel-settings 监听任一航线参数变化（防抖重写已打开的面板）。
export const ftcFuelSliders = fuelSliders;
export const ftcReactorUsages = reactorUsages;

// 读取某航线的 FTC 最优燃料滑块；未计算过（undefined）返回 undefined（不改滑块）。
// ⚠️ 航线键是**复合键**：起终点/网关标志必须与写入时一致，否则读不到 —— 这正是本轮的
// 修复目标（船换到新航线后不得再读到上一条航线的值）。
export function getFtcFuelSlider(
  ship: string | undefined,
  from: string,
  to: string,
  useGateway: boolean,
): number | undefined {
  if (ship === undefined) {
    return undefined;
  }
  return fuelSliders.value[ftcRouteKey(ship, from, to, useGateway)];
}

// 读取某航线的 FTC 最优反应堆使用量；未计算过返回 undefined（不改滑块）。
export function getFtcReactorUsage(
  ship: string | undefined,
  from: string,
  to: string,
  useGateway: boolean,
): number | undefined {
  if (ship === undefined) {
    return undefined;
  }
  return reactorUsages.value[ftcRouteKey(ship, from, to, useGateway)];
}

// 写入某航线的 FTC 最优燃料滑块。⚠️ 键由写入方用 ftcRouteKey(...) 拼好（唯一写入方是
// ftc-compute，它必须把**同一个键**同时放进 lastFtcCompute.key —— 两者格式必须逐位一致，
// 否则 DEPART/SFC 等待方按 key 匹配不到本次计算）。
// 值未变时跳过（避免重复触发重写/写 localStorage）。
export function setFtcFuelSlider(routeKey: string, value: number) {
  if (fuelSliders.value[routeKey] === value) {
    return;
  }
  fuelSliders.value = { ...fuelSliders.value, [routeKey]: value };
}

// 写入某航线的 FTC 最优反应堆使用量。值未变时跳过。
export function setFtcReactorUsage(routeKey: string, value: number) {
  if (reactorUsages.value[routeKey] === value) {
    return;
  }
  reactorUsages.value = { ...reactorUsages.value, [routeKey]: value };
}
