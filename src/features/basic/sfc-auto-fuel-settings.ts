import { clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';

// 打开 SFC 时自动写入的燃料参数。
const FUEL_CONSUMPTION = 0.1;
const REACTOR_USAGE = 1;

// 预留接口：是否自动勾选“使用跃迁点”。默认不勾选。
const USE_JUMP_POINT = false;

// 预留接口：是否自动勾选“抵达后卸货”。默认勾选。
const UNLOAD_AFTER_ARRIVAL = false;

// 预留接口：是否在燃料参数设置完成后自动点击“开始”按钮。默认关闭。
// 点击“开始”会提交飞行（服务端通信），按 ToS 需玩家显式操作，仅当显式开启时生效。
const CLICK_START = false;

// 最大重试次数
const MAX_RETRIES = 3;
// 重试间隔（毫秒）
const RETRY_DELAY_MS = 500;

function getSliderLabel(slider: Element) {
  // 行处于 active 或 passive 状态时都能取到标签，避免被动行内滑块被误判为无标签。
  const row = slider.closest(
    `.${C.FormComponent.containerActive}, .${C.FormComponent.containerPassive}`,
  );
  const label = row ? _$(row, 'label') : undefined;
  return label?.textContent?.trim();
}

// 记录每个 SFC 磁贴的滑块标签配置状态：
//   - 'done' 表示成功配置
//   - 数字表示当前重试次数（未成功）
const configuredLabels = new WeakMap<Element, Map<string, number | 'done'>>();

// 每个磁贴正在写入的滑块标签：写入期间 React 重建的新节点会再次触发回调，
// 用该集合同步拦截并发重复写入；写入失败则移除，允许后续重建时重试。
const pendingLabels = new WeakMap<Element, Set<string>>();

async function configureSlider(tile: PrunTile, slider: Element) {
  // 星系内飞行时“反应堆使用量”不是轨道条（显示为 --），不会触发写入；燃料消耗仍会调整。
  const label = getSliderLabel(slider);
  let value: number;
  if (label === '燃料消耗') {
    value = FUEL_CONSUMPTION;
  } else if (label === '反应堆使用量') {
    value = REACTOR_USAGE;
  } else {
    return;
  }

  let labelMap = configuredLabels.get(tile.anchor);
  if (!labelMap) {
    labelMap = new Map();
    configuredLabels.set(tile.anchor, labelMap);
  }

  const state = labelMap.get(label);
  // 已成功或已放弃（达到最大重试次数）则跳过
  if (state === 'done' || (typeof state === 'number' && state >= MAX_RETRIES)) {
    return;
  }
  let pending = pendingLabels.get(tile.anchor);
  if (!pending) {
    pending = new Set();
    pendingLabels.set(tile.anchor, pending);
  }
  if (pending.has(label)) {
    return;
  }
  pending.add(label);
  let shouldRetry = false;
  try {
    // 只有写入成功才标记，避免滑块未就绪的骨架节点被误判为已配置。
    const success = await setSliderValue(slider, value);
    if (success) {
      console.log(`[sfc-auto-fuel-settings] set ${label} to ${value}`);
      labelMap.set(label, 'done');
      await maybeClickStart(tile);
    } else {
      console.warn(`[sfc-auto-fuel-settings] failed to set ${label} to ${value}`);
      const currentRetries = typeof state === 'number' ? state : 0;
      const nextRetries = currentRetries + 1;
      if (nextRetries < MAX_RETRIES) {
        labelMap.set(label, nextRetries);
        shouldRetry = true;
      } else {
        // 达到最大重试次数，标记为放弃（不再尝试）
        labelMap.set(label, MAX_RETRIES);
      }
    }
  } finally {
    pending.delete(label);
  }
  // 延迟重试：先释放 pending，避免递归重新进入时被并发拦截卡住。
  if (shouldRetry) {
    await sleep(RETRY_DELAY_MS);
    await configureSlider(tile, slider);
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
  // 最大值：直接点击轨道最右端，不依赖 lastMark，更稳健
  if (value >= range.max) {
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
  } else {
    await clickSliderTrack(slider, value, range);
  }
  // 等 React 重新渲染后校验写入结果，容差放宽到 0.01
  await sleep(0);
  const handle = _$(slider, 'rc-slider-handle');
  const current = Number(handle?.getAttribute('aria-valuenow'));
  return Number.isFinite(current) && Math.abs(current - value) < 0.01;
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
  if (active) {
    return;
  }
  console.log(`[sfc-auto-fuel-settings] select ${label}`);
  await clickElement(radio as HTMLElement);
}

// 记录已点击“开始”的磁贴，避免重复点击。
const startClicked = new WeakSet<Element>();

// 等 SFC 指令表单的“开始”按钮渲染出来。
async function findStartButton(tile: PrunTile) {
  const command = await $(tile.anchor, C.FormComponent.containerCommand);
  return $(command, C.Button.success);
}

// 开启 CLICK_START 时，等“开始”按钮出现后再判断是否点击。
async function maybeClickStart(tile: PrunTile) {
  if (!CLICK_START) {
    return;
  }
  if (startClicked.has(tile.anchor)) {
    return;
  }
  const labelMap = configuredLabels.get(tile.anchor);
  if (!labelMap) {
    return;
  }
  const targets = ['燃料消耗', '反应堆使用量'];
  if (!targets.every(x => labelMap.get(x) === 'done')) {
    // 星系内飞行没有“反应堆使用量”滑块，永不满足，因此不会自动点击。
    return;
  }
  // 等“开始”按钮渲染出来后再判断是否点击。
  const button = await findStartButton(tile);
  if (button.classList.contains(C.Button.disabled)) {
    console.warn('[sfc-auto-fuel-settings] 开始按钮尚未就绪（可能未设置目的地），跳过');
    return;
  }
  console.log('[sfc-auto-fuel-settings] click 开始');
  startClicked.add(tile.anchor);
  await clickElement(button as HTMLElement);
}

// 等目的地行程统计(MissionPlan)加载出来后再开始配置,
// 此时滑块已基于真实数据渲染,避免在未就绪的骨架节点上写入。
async function onTileReady(tile: PrunTile) {
  await $(tile.anchor, C.MissionPlan.stats);
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

features.add(import.meta.url, init, 'SFC：目的地加载后将燃料消耗设为 0.1、反应堆使用量设为 100%。');
