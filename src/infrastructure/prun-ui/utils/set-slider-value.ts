import { sleep } from '@src/utils/sleep';

export function findFormSlider(form: Element, labels: readonly string[]) {
  const expected = labels.map(label => label.trim().toUpperCase());
  const matches = _$$(form, 'rc-slider').filter(slider => {
    // BTF and RT use different hashes for the same FormComponent selectors.
    const row = slider.closest(
      '[class*="FormComponent__containerActive___"], [class*="FormComponent__containerPassive___"], [class*="FormComponent__containerActiveMobile___"], [class*="FormComponent__containerPassiveMobile___"]',
    );
    const label = row?.querySelector('label, [class*="FormComponent__label___"]')?.textContent;
    return (
      row != null &&
      form.contains(row) &&
      label != null &&
      expected.includes(label.trim().toUpperCase())
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

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

const SLIDER_EPSILON = 0.01;
// 轨道点击只能落到像素对应的档位，剩余偏差用方向键补齐；上限防止步长不整除时死循环。
const MAX_ARROW_PRESSES = 20;

function sliderHandle(slider: Element) {
  return _$(slider, 'rc-slider-handle');
}

// rc-slider 只处理落在手柄上的键事件：轨道点击不一定让手柄获得焦点，故显式聚焦。
function pressSliderKey(handle: Element, key: string, keyCode: number) {
  if (handle instanceof HTMLElement) {
    handle.focus();
  }
  handle.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code: key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function pressArrow(slider: Element, direction: number) {
  const handle = sliderHandle(slider);
  if (handle === undefined) {
    return undefined;
  }
  pressSliderKey(handle, direction > 0 ? 'ArrowRight' : 'ArrowLeft', direction > 0 ? 39 : 37);
  await sleep(0);
  return getSliderValue(slider);
}

// 用方向键从当前值微调目标值。先按一次量出步长：步长跨过目标（或键事件不生效）就放弃，
// 绝不来回拉锯——每次键盘事件在游戏里都触发一次服务器重算。
async function nudgeSliderValue(slider: Element, value: number) {
  let current = getSliderValue(slider);
  if (current === undefined) {
    return undefined;
  }
  const direction = value > current ? 1 : -1;
  const next = await pressArrow(slider, direction);
  if (next === undefined || next === current) {
    return current;
  }
  if ((value - next) * direction < 0) {
    return next;
  }
  const step = Math.abs(next - current);
  const remaining = Math.min(MAX_ARROW_PRESSES, Math.ceil(Math.abs(value - next) / step));
  current = next;
  for (let i = 0; i < remaining && Math.abs(current - value) >= SLIDER_EPSILON; i++) {
    const after = await pressArrow(slider, direction);
    if (after === undefined || after === current || (value - after) * direction < 0) {
      return after ?? current;
    }
    current = after;
  }
  return current;
}

// 写入滑块并返回实际读到的值（无法交互时 undefined）。
// 顺序：点击轨道定位 → 边界值用 Home/End 补齐 → 方向键消除剩余档位偏差。
async function writeSliderValue(slider: Element, value: number, exactMaximum: boolean) {
  const range = getSliderRange(slider);
  if (!range) {
    return undefined;
  }
  if (value >= range.max && !exactMaximum) {
    // 最大值：直接点击轨道最右端，不依赖 lastMark，更稳健
    await clickSliderMax(slider);
  } else {
    await clickSliderTrack(slider, value, range);
  }
  await sleep(0);
  let current = getSliderValue(slider);
  if (current === undefined) {
    return undefined;
  }
  if (Math.abs(current - value) < SLIDER_EPSILON) {
    return current;
  }
  // 边界档：轨道端点点击常落在相邻档（窄轨道点最右端会得到 99%），Home/End 才是精确端值。
  const atMax = value >= range.max;
  const atMin = value <= range.min;
  if (atMax || atMin) {
    const handle = sliderHandle(slider);
    if (handle !== undefined) {
      pressSliderKey(handle, atMax ? 'End' : 'Home', atMax ? 35 : 36);
      await sleep(0);
      current = getSliderValue(slider);
      if (current !== undefined && Math.abs(current - value) < SLIDER_EPSILON) {
        return current;
      }
    }
  }
  return (await nudgeSliderValue(slider, value)) ?? current;
}

// 设置 rc-slider 滑块的值并校验写入结果（容差 0.01）。
// 注意：滑块交互依赖 getBoundingClientRect，目标窗口不能处于 display:none
// （矩形为 0 会导致百分比计算错误），查询引擎应把窗口移出屏幕而非隐藏。
export async function setSliderValue(
  slider: Element,
  value: number,
  { exactMaximum = false } = {},
): Promise<boolean> {
  if (slider.classList.contains('rc-slider-disabled')) {
    return false;
  }
  const current = await writeSliderValue(slider, value, exactMaximum);
  return current !== undefined && Math.abs(current - value) < SLIDER_EPSILON;
}

// 读取滑块当前值。
export function getSliderValue(slider: Element): number | undefined {
  const handle = sliderHandle(slider);
  const current = Number(handle?.getAttribute('aria-valuenow'));
  return Number.isFinite(current) ? current : undefined;
}

// 同一档位在不同表单里的量程口径不同：航点/试飞面板是 1–100 的百分比，
// SFC 反应堆滑块是 0–1 的比例。按量程判定，不按表单类型硬编码。
export function sliderUsesFractions(slider: Element) {
  const range = getSliderRange(slider);
  return range !== undefined && range.max <= 1.5;
}

// 百分比（1–100）→ 该滑块实际可写的值。
export function sliderValueFromPercent(slider: Element, percent: number) {
  return sliderUsesFractions(slider) ? percent / 100 : percent;
}
