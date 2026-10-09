// 环线装船工具（提炼自 chain-planner.ts，便于 Node 测试）。
//
// 把 cargo 按两种策略之一装入船舱：
//   - 比例缩减：所有 item 按同一比例缩放（出发地装载 CX 采购物资用——超载则让
//     用户减少天数 / 换更大的船，全局缩量比逐条截断更可预期）。
//   - 逐 item 优先：按 dest 优先级装填每条 item；可装多少装多少，超载 item
//     跳过（环线链上输送用——按比例切割会让每个下游都拿不到足额，违背
//     「按下游紧迫度优先补齐」的环线补给目的；次要的下游保留到下一航次）。
//
// 两个函数均显式接受 state，避免闭包副作用，方便 Node 端直接 import 跑回归。

export interface CargoItem {
  ticker: string;
  amount: number;
  from?: string;
  dest: string;
}

export interface CargoState {
  /** 当前舱载 [weight, volume]. */
  weight: number;
  volume: number;
  /** 船的剩余容量. */
  free: { weight: number; volume: number };
  /** 已装载的 cargo 列表（追加条目，非替换）. */
  cargo: CargoItem[];
}

/** 单 ticker 单位重量 / 体积（在生产代码里调 matWeightVolume；这里只声明接口). */
export interface MaterialWeightVolume {
  weight: number;
  volume: number;
}
export type GetMatWV = (ticker: string, amount: number) => MaterialWeightVolume;

/** 把 cargo 装入船舱：所有 item 按同一比例缩放. */
export function pushItemsProportional(
  items: CargoItem[],
  state: CargoState,
  getWV: GetMatWV,
): boolean {
  if (items.length === 0) {
    return false;
  }
  let loadWeight = 0;
  let loadVolume = 0;
  for (const item of items) {
    const { weight, volume } = getWV(item.ticker, item.amount);
    loadWeight += weight;
    loadVolume += volume;
  }
  let scale = 1;
  if (loadWeight > state.free.weight - state.weight) {
    scale = Math.min(scale, (state.free.weight - state.weight) / loadWeight);
  }
  if (loadVolume > state.free.volume - state.volume) {
    scale = Math.min(scale, (state.free.volume - state.volume) / loadVolume);
  }
  if (scale <= 0) {
    return true;
  }
  for (const item of items) {
    item.amount = Math.floor(item.amount * scale);
  }
  const scaledWeight = loadWeight * scale;
  const scaledVolume = loadVolume * scale;
  state.weight += scaledWeight;
  state.volume += scaledVolume;
  state.cargo = [...state.cargo, ...items];
  return scale < 1;
}

/**
 * 把 cargo 装入船舱：按 dest priority 升序装填每条 item；
 * 每条 item 尽量按需装满，超载则部分装入；剩余舱容装不下时整条跳过。
 *
 * @returns 是否发生截断（任一 item 没按需装满就算 true）。
 */
export function pushItemsPrioritised(
  items: CargoItem[],
  state: CargoState,
  getWV: GetMatWV,
  priority: Record<string, number>,
): boolean {
  const sorted = [...items].sort((a, b) => {
    const pa = priority[a.dest] ?? Number.POSITIVE_INFINITY;
    const pb = priority[b.dest] ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
  let clipped = false;
  for (const item of sorted) {
    const remainingW = state.free.weight - state.weight;
    const remainingV = state.free.volume - state.volume;
    if (remainingW <= 0 || remainingV <= 0) {
      clipped = true;
      continue;
    }
    const { weight: itemW, volume: itemV } = getWV(item.ticker, 1);
    const totalW = itemW * item.amount;
    const totalV = itemV * item.amount;
    let amount = item.amount;
    if (totalW > remainingW && itemW > 0) {
      amount = Math.min(amount, Math.floor(remainingW / itemW));
      clipped = true;
    }
    if (totalV > remainingV && itemV > 0) {
      amount = Math.min(amount, Math.floor(remainingV / itemV));
      clipped = true;
    }
    if (amount <= 0) {
      clipped = true;
      continue;
    }
    item.amount = amount;
    const { weight, volume } = getWV(item.ticker, amount);
    state.weight += weight;
    state.volume += volume;
    state.cargo = [...state.cargo, item];
  }
  return clipped;
}
