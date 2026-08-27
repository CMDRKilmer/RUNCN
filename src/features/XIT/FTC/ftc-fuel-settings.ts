import { persistedRef } from '@src/utils/persisted-ref';

// FTC 计算出的最优燃料参数，供 SFC 自动设置（features/basic/sfc-auto-fuel-settings）复用。
// 每次 FTC「计算最优方案」成功后写入（localStorage 持久化，刷新后仍生效）；
// 未计算过时为 undefined（SFC 不改动滑块，由玩家自行决定）。
export const ftcFuelSlider = persistedRef<number | undefined>(
  'rprun.ftc.fuel-slider.v1',
  undefined,
);
export const ftcReactorUsage = persistedRef<number | undefined>(
  'rprun.ftc.reactor-usage.v1',
  undefined,
);
