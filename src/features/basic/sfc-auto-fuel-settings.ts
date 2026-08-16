import { clickElement } from '@src/util';

// 打开 SFC 时自动写入的燃料参数。
const FUEL_CONSUMPTION = 0.1;
const REACTOR_USAGE = 1;

// 预留接口：是否自动勾选“使用跃迁点”。默认不勾选。
// const USE_JUMP_POINT = false;

// 预留接口：是否自动勾选“抵达后卸货”。默认勾选。
const UNLOAD_AFTER_ARRIVAL = true;

function getSliderLabel(slider: Element) {
  const row = slider.closest(`.${C.FormComponent.containerActive}`);
  const label = row ? _$(row, 'label') : undefined;
  return label?.textContent?.trim();
}

async function configureSlider(slider: Element) {
  const label = getSliderLabel(slider);
  if (label === '燃料消耗') {
    await setSliderValue(slider, FUEL_CONSUMPTION);
  } else if (label === '反应堆使用量') {
    await setSliderValue(slider, REACTOR_USAGE);
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

// 在滑块轨道上按目标值对应的百分比位置模拟一次 mousedown，
// rc-slider 的 onMouseDown 会依据 clientX 计算并吸附到最近的步进值。
function clickSliderTrack(slider: Element, value: number, range: { min: number; max: number }) {
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
  // 补发 mouseup，让 rc-slider 清理 document 级监听并触发 onChangeComplete。
  document.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }),
  );
}

async function setSliderValue(slider: Element, value: number) {
  if (slider.classList.contains('rc-slider-disabled')) {
    return;
  }
  const range = getSliderRange(slider);
  if (!range) {
    return;
  }
  // 最大值直接点击末尾刻度，避免离散滑块在右边界吸附到前一档。
  if (value >= range.max) {
    const mark = await $(slider, 'rc-slider-mark');
    const lastMark = mark?.lastElementChild;
    if (!lastMark) return;
    await clickElement(lastMark as HTMLElement);
    return;
  }
  clickSliderTrack(slider, value, range);
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
    void configureSlider(slider);
  });
  subscribe($$(tile.anchor, C.RadioItem.container), radio => {
    // void selectRadioItem(radio, '使用跃迁点', USE_JUMP_POINT);
    void selectRadioItem(radio, '抵达后卸货', UNLOAD_AFTER_ARRIVAL);
  });
}

function init() {
  tiles.observe('SFC', onTileReady);
}

features.add(import.meta.url, init, 'SFC：自动将燃料消耗设为 0.1、反应堆使用量设为 100%。');
