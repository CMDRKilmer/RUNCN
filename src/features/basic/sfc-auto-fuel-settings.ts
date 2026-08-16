import { clickElement } from '@src/util';
import { sleep } from '@src/utils/sleep';

// 打开 SFC 时自动写入的燃料参数。
const FUEL_CONSUMPTION = 0.1;
const REACTOR_USAGE = 1;

// 预留接口：是否自动勾选“使用跃迁点”。默认不勾选。
const USE_JUMP_POINT = false;

// 预留接口：是否自动勾选“抵达后卸货”。默认勾选。
const UNLOAD_AFTER_ARRIVAL = true;

function getSliderLabel(slider: Element) {
  const row = slider.closest(`.${C.FormComponent.containerActive}`);
  const label = row ? _$(row, 'label') : undefined;
  return label?.textContent?.trim();
}

// 记录每个 SFC 磁贴已成功写入的滑块标签，避免节点重建后重复写入、覆盖手动修改。
const configuredLabels = new WeakMap<Element, Set<string>>();

async function configureSlider(tile: PrunTile, slider: Element) {
  const label = getSliderLabel(slider);
  let value: number;
  if (label === '燃料消耗') {
    value = FUEL_CONSUMPTION;
  } else if (label === '反应堆使用量') {
    value = REACTOR_USAGE;
  } else {
    return;
  }
  let labels = configuredLabels.get(tile.anchor);
  if (!labels) {
    labels = new Set();
    configuredLabels.set(tile.anchor, labels);
  }
  if (labels.has(label)) {
    return;
  }
  // 只有写入成功才标记，避免滑块未就绪的骨架节点被误判为已配置。
  if (await setSliderValue(slider, value)) {
    labels.add(label);
  }
}

function getSliderRange(slider: Element) {
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

async function setSliderValue(slider: Element, value: number): Promise<boolean> {
  if (slider.classList.contains('rc-slider-disabled')) {
    return false;
  }
  const range = getSliderRange(slider);
  if (!range) {
    return false;
  }
  // 最大值直接点击末尾刻度，避免离散滑块在右边界吸附到前一档。
  if (value >= range.max) {
    const mark = await $(slider, 'rc-slider-mark');
    const lastMark = mark?.lastElementChild;
    if (!lastMark) return false;
    await clickElement(lastMark as HTMLElement);
  } else {
    await clickSliderTrack(slider, value, range);
  }
  // 等 React 重新渲染后校验写入结果，区分“已生效”与“未就绪的骨架节点”。
  await sleep(0);
  const handle = _$(slider, 'rc-slider-handle');
  const current = Number(handle?.getAttribute('aria-valuenow'));
  return Number.isFinite(current) && Math.abs(current - value) < 1e-9;
}

// 预留：按标签勾选指定单选选项（如“使用跃迁点”“抵达后卸货”）。
async function selectRadioItem(radio: Element, label: string, enabled: boolean) {
  if (!enabled) {
    return;
  }
  const value = _$(radio, C.RadioItem.value);
  if (value?.textContent?.trim() !== label) {
    return;
  }
  const indicator = _$(radio, C.RadioItem.indicator);
  const active = indicator?.classList.contains(C.RadioItem.active) ?? false;
  if (!active) {
    await clickElement(radio as HTMLElement);
  }
}

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, 'rc-slider'), slider => {
    void configureSlider(tile, slider);
  });
  subscribe($$(tile.anchor, C.RadioItem.container), radio => {
    void selectRadioItem(radio, '使用跃迁点', USE_JUMP_POINT);
    void selectRadioItem(radio, '抵达后卸货', UNLOAD_AFTER_ARRIVAL);
  });
}

function init() {
  tiles.observe('SFC', onTileReady);
}

features.add(import.meta.url, init, 'SFC：自动将燃料消耗设为 0.1、反应堆使用量设为 100%。');
