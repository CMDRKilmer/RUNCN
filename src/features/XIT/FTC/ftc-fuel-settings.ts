import { persistedRef } from '@src/utils/persisted-ref';

// 每艘飞船的 FTC 最优燃料参数（按飞船 registration 键控的持久化 map）。
// 环线/多船并行时各船 SFC 面板同时打开：若用单一全局值，后算完的船会覆盖
// 其他船的参数（互相覆盖 + 反馈抖动），导致飞船不按自己的最优燃料飞行。
// 按船存储后，每艘船各自读写自己的最优值，互不影响。
type ShipFtcValues = Record<string, number>;

const fuelSliders = persistedRef<ShipFtcValues>('rprun.ftc.fuel-slider.v2', {});
const reactorUsages = persistedRef<ShipFtcValues>('rprun.ftc.reactor-usage.v2', {});

// 供 sfc-auto-fuel-settings 监听任一船参数变化（防抖重写已打开的面板）。
export const ftcFuelSliders = fuelSliders;
export const ftcReactorUsages = reactorUsages;

// 读取某船的 FTC 最优燃料滑块；未计算过（undefined）返回 undefined（不改滑块）。
export function getFtcFuelSlider(ship: string | undefined): number | undefined {
  return ship !== undefined ? fuelSliders.value[ship] : undefined;
}

// 读取某船的 FTC 最优反应堆使用量；未计算过（undefined）返回 undefined（不改滑块）。
export function getFtcReactorUsage(ship: string | undefined): number | undefined {
  return ship !== undefined ? reactorUsages.value[ship] : undefined;
}

// 写入某船的 FTC 最优燃料滑块。值未变时跳过（避免重复触发重写/写 localStorage）。
export function setFtcFuelSlider(ship: string, value: number) {
  if (fuelSliders.value[ship] === value) {
    return;
  }
  fuelSliders.value = { ...fuelSliders.value, [ship]: value };
}

// 写入某船的 FTC 最优反应堆使用量。值未变时跳过。
export function setFtcReactorUsage(ship: string, value: number) {
  if (reactorUsages.value[ship] === value) {
    return;
  }
  reactorUsages.value = { ...reactorUsages.value, [ship]: value };
}
