import { sleep } from '@src/utils/sleep';

// 被 FTC 查询引擎等模块独占的 SFC 磁贴：sfc-auto-fuel-settings 跳过这些磁贴，
// 避免两个模块同时对同一组滑块写入互相覆盖。
const reservedTiles = new WeakSet<Element>();

export function reserveTile(anchor: Element) {
  reservedTiles.add(anchor);
}

export function releaseTile(anchor: Element) {
  reservedTiles.delete(anchor);
}

export function isTileReserved(anchor: Element | undefined) {
  return anchor !== undefined && reservedTiles.has(anchor);
}

export function getSliderRange(slider: Element) {
  const handle = _$(slider, 'rc-slider-handle');
  const min = Number(handle?.getAttribute('aria-valuemin'));
  const max = Number(handle?.getAttribute('aria-valuemax'));
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return undefined;
  }
  return { min, max };
}

// 在滑块轨道上按目标值对应的百分比位置模拟一次点击，
// rc-slider 的 onMouseDown 会依据 clientX 计算并吸附到最近的步进值。
// mousedown 与 mouseup 之间必须间隔一个微任务，让 React 先完成重渲染，
// 否则 onChangeComplete 会拿到旧值，把刚写入的新值覆盖回去（console 实测验证）。
async function clickSliderTrack(
  slider: Element,
  value: number,
  range: { min: number; max: number },
) {
  const rect = slider.getBoundingClientRect();
  const percent = (value - range.min) / (range.max - range.min);
  const clientX = rect.left + rect.width * percent;
  const clientY = rect.top + rect.height / 2;
  slider.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
    }),
  );
  // 等 React flush 重渲染后再补发 mouseup，让 onChangeComplete 携带新值。
  await Promise.resolve();
  document.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }),
  );
}

async function clickSliderMax(slider: Element) {
  const rect = slider.getBoundingClientRect();
  // 留 2px 边距避免边界问题
  const clientX = rect.right - 2;
  const clientY = rect.top + rect.height / 2;
  slider.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
    }),
  );
  await Promise.resolve();
  document.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }),
  );
}

// 设置 rc-slider 滑块的值并校验写入结果（容差 0.01）。
// 注意：滑块交互依赖 getBoundingClientRect，目标窗口不能处于 display:none
// （矩形为 0 会导致百分比计算错误），查询引擎应把窗口移出屏幕而非隐藏。
export async function setSliderValue(slider: Element, value: number): Promise<boolean> {
  if (slider.classList.contains('rc-slider-disabled')) {
    return false;
  }
  const range = getSliderRange(slider);
  if (!range) {
    return false;
  }
  // 最大值：直接点击轨道最右端，不依赖 lastMark，更稳健
  if (value >= range.max) {
    await clickSliderMax(slider);
  } else {
    await clickSliderTrack(slider, value, range);
  }
  // 等 React 重新渲染后校验写入结果，容差放宽到 0.01
  await sleep(0);
  const handle = _$(slider, 'rc-slider-handle');
  const current = Number(handle?.getAttribute('aria-valuenow'));
  return Number.isFinite(current) && Math.abs(current - value) < 0.01;
}

// 读取滑块当前值。
export function getSliderValue(slider: Element): number | undefined {
  const handle = _$(slider, 'rc-slider-handle');
  const current = Number(handle?.getAttribute('aria-valuenow'));
  return Number.isFinite(current) ? current : undefined;
}
