import { watch } from 'vue';
import { refTextContent, refValue } from '@src/utils/reactive-dom';
import { clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';
import onNodeDisconnected from '@src/utils/on-node-disconnected';
import {
  isTileReserved,
  setSliderValue,
  getSliderValue,
} from '@src/infrastructure/prun-ui/utils/set-slider-value';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { ftcFuelSlider, ftcReactorUsage } from '@src/features/XIT/FTC/ftc-fuel-settings';
import { computeFtcPlan } from '@src/features/XIT/FTC/ftc-compute';

// 打开 SFC 时自动写入的燃料参数 = FTC 计算出的最优方案（燃料消耗 / 反应堆使用量）。
// 未在 FTC 计算过（undefined）时不改动滑块，由玩家自行决定。

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

// 已打开的 SFC 磁贴当前滑块（按标签），FTC 参数变化时自动重新写入。
const tileSliders = new Map<PrunTile, Map<string, Element>>();

// 读取 FTC 计算出的最优燃料参数；无结果（undefined）返回 undefined（不改滑块）。
function ftcValueFor(label: string | undefined): number | undefined {
  if (label === '燃料消耗') {
    return ftcFuelSlider.value;
  }
  if (label === '反应堆使用量') {
    return ftcReactorUsage.value;
  }
  return undefined;
}

async function configureSlider(tile: PrunTile, slider: Element) {
  // FTC 查询引擎独占的窗口由引擎自己写滑块，这里跳过避免互相覆盖。
  if (isTileReserved(tile.anchor)) {
    return;
  }
  // React 已重建/卸载的旧节点：跳过（避免对 detached 元素重复点击）。
  if (!slider.isConnected) {
    return;
  }
  // 星系内飞行时“反应堆使用量”不是轨道条（显示为 --），不会触发写入；燃料消耗仍会调整。
  const label = getSliderLabel(slider);
  if (!label) {
    return;
  }
  const value = ftcValueFor(label);
  // 无 FTC 计算结果：不改滑块，由玩家自行决定。
  if (value === undefined) {
    return;
  }

  let labelMap = configuredLabels.get(tile.anchor);
  if (!labelMap) {
    labelMap = new Map();
    configuredLabels.set(tile.anchor, labelMap);
  }

  // 滑块已是目标值：无需点击（避免重复触发游戏重算/确认弹窗），直接标记已配置。
  const current = getSliderValue(slider);
  if (current !== undefined && Math.abs(current - value) < 0.01) {
    labelMap.set(label, 'done');
    console.log(`[sfc-auto-fuel-settings] ${label} 已是目标值 ${value}`);
    return;
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
    // 重试时用当前最新的滑块节点（React 可能已重建旧节点，detached 节点点击无效）。
    const latest = tileSliders.get(tile)?.get(label);
    await configureSlider(tile, latest ?? slider);
  }
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

// FTC 参数变化时，对已打开的 SFC 磁贴重新写入（先清除已配置标记，允许新值覆盖）。
// 防抖合并：一次计算连续写入燃料/反应堆两个参数（或并发计算先后完成）时只执行一次，
// 避免重复写滑块导致游戏多次重算/弹确认。
// FTC 参数变化时，对已打开的 SFC 磁贴重新写入（先清除已配置标记，允许新值覆盖）。
// 防抖合并：一次计算连续写入燃料/反应堆两个参数（或并发计算先后完成）时只执行一次，
// 避免重复写滑块导致游戏多次重算/弹确认。
// onlyTile 不传时遍历所有 SFC 磁贴（FTC 面板手动计算场景）；传入时仅刷那一个磁贴，
// 绕开 watch 的同值短路——用户切目的地后 pushRouteToFtc 末尾主动调一次，保证新航线
// 参数一定被检查/写入。
let applyFtcTimer: number | undefined;
function applyFtcSettingsDebounced() {
  window.clearTimeout(applyFtcTimer);
  applyFtcTimer = window.setTimeout(() => applyFtcSettings(), 60);
}
function applyFtcSettings(onlyTile?: PrunTile) {
  for (const [tile, sliders] of tileSliders) {
    if (onlyTile !== undefined && tile !== onlyTile) {
      continue;
    }
    if (isTileReserved(tile.anchor)) {
      continue;
    }
    configuredLabels.delete(tile.anchor);
    for (const slider of sliders.values()) {
      // 只处理仍在 DOM 的滑块（旧的 detached 节点等下一次订阅覆盖）。
      if (!slider.isConnected) {
        continue;
      }
      void configureSlider(tile, slider);
    }
  }
}
watch([ftcFuelSlider, ftcReactorUsage], applyFtcSettingsDebounced);

// 已推送给 FTC 的航线（飞船|起|终|网关），防反馈循环：
// FTC 写滑块 → SFC 重算（起终点不变）→ 不再重复推送；仅用户改起终点时才重新推送。
const lastPushedRoute = new WeakMap<Element, string>();

// 读 SFC 表单「使用跃迁点」单选当前状态（激活 → 走网关航线计算）。
function readGatewayState(tile: PrunTile): boolean {
  for (const radio of _$$(tile.anchor, C.RadioItem.container)) {
    const value = _$(radio, C.RadioItem.value);
    if (value?.textContent?.trim() !== '使用跃迁点') {
      continue;
    }
    const indicator = _$(radio, C.RadioItem.indicator);
    return indicator?.classList.contains(C.RadioItem.active) ?? false;
  }
  return false;
}

// 每个磁贴的 pushRouteToFtc 防抖定时器：stats 文本短时间内多次变化（用户输入中触发
// 多次服务器重算）合并为一次推送，避免中间状态（input.value 仍为旧目的地）误读后
// key 不变提前 return、最终漏推。
const pushTimers = new WeakMap<Element, number>();
function schedulePushRoute(tile: PrunTile) {
  const prev = pushTimers.get(tile.anchor);
  if (prev !== undefined) {
    window.clearTimeout(prev);
  }
  const timer = window.setTimeout(() => {
    pushTimers.delete(tile.anchor);
    void pushRouteToFtc(tile);
  }, 300);
  pushTimers.set(tile.anchor, timer);
}

// SFC 重算完成后，把当前飞船 + 起终点自动推送给 FTC 计算最优燃料参数
// （计算不依赖 FTC 面板打开，成功后在 ftc-compute 内写入共享参数，滑块自动跟随）。
// 起点 = 飞船当前位置（SFC 位置固定为飞船地址）；终点 = 目的地输入框 canonicalized 自然 ID
// （如 OT-580 / FK-794b）。不依赖飞行计划 store/表格 missionId——实测改目的地后
// MissionPlan 表格 data-prun-id 不变，无法作为信号或读计划。
async function pushRouteToFtc(tile: PrunTile) {
  const ship = tile.parameter;
  if (!ship) {
    return;
  }
  const s = shipsStore.getByRegistration(ship);
  const from = s?.address ? getEntityNaturalIdFromAddress(s.address) : undefined;
  const input = _$(tile.anchor, C.AddressSelector.input) as HTMLInputElement | undefined;
  const to = input?.value?.trim();
  if (!from || !to) {
    return;
  }
  const viaGateway = readGatewayState(tile);
  const key = `${ship}|${from}|${to}|${viaGateway ? 'gw' : 'nat'}`;
  if (lastPushedRoute.get(tile.anchor) === key) {
    return;
  }
  lastPushedRoute.set(tile.anchor, key);
  console.log(
    `[sfc-auto-fuel-settings] 推送航线给 FTC：${ship} ${from} → ${to}${viaGateway ? '（网关）' : ''}`,
  );
  const result = await computeFtcPlan({
    shipRegistration: ship,
    from,
    to,
    useGateway: viaGateway,
  });
  // 计算期间航线已再次变化：丢弃过期结果，避免旧航线参数覆盖新航线（重复响应）。
  if (lastPushedRoute.get(tile.anchor) !== key) {
    console.log('[sfc-auto-fuel-settings] 航线已变化，丢弃过期计算结果');
    return;
  }
  if (!result.ok) {
    console.warn(`[sfc-auto-fuel-settings] FTC 自动计算失败：${result.message}`);
    return;
  }
  // 算完后立刻清掉自己的已配置标记，并主动遍历当前磁贴的滑块重新检查写入。
  // 绕开 watch 的同值短路：ftcFuelSlider/Reactor 同值赋值时 watch 不触发，
  // applyFtcSettings 不跑，fuel/reactor slider 不会被"确认"过一次，用户的
  // console 看不到 set 日志。主动调 applyFtcSettings(tile) 保证新航线参数
  // 一定被 configureSlider 走过一次（current === value 时打 already 日志）。
  configuredLabels.delete(tile.anchor);
  applyFtcSettings(tile);
}

// 等 MissionPlan 表格加载出来后再开始配置：滑块基于真实数据渲染，
// 避免在未就绪的骨架节点上写入。
async function onTileReady(tile: PrunTile) {
  const table = await $(tile.anchor, C.MissionPlan.table);
  // 磁贴关闭时清理追踪，避免对已卸载元素重复写入。
  onNodeDisconnected(tile.anchor, () => tileSliders.delete(tile));
  // 以 MissionPlan 表格文本变化作为「重算完成」信号：服务器完成 SHIP_FLIGHT_MISSION 重算后
  // 才会刷新整个表格内容（含目的地/时长/燃料等列），地址输入中间状态不会触发推送。
  // （之前用 stats 文本，但 AddressSelector 输入过程中 stats 会被搜索响应间接带动，过敏。）
  watch(refTextContent(table), () => {
    schedulePushRoute(tile);
  });
  // 补充信号：监听目的地输入框 value 变化。用户在 listbox 选中项目后 input.value
  // 立刻同步（无须等服务器重算），触发推送保证 FTC 不会漏掉新目的地。
  // 表单表格尚未刷新时 FTC 会先按新目的地计算（FTC 不依赖服务器计划），服务器后续
  // 重算到位后 table 信号再次触发推送——key 未变则 lastPushedRoute 提前 return。
  const input = _$(tile.anchor, C.AddressSelector.input) as HTMLInputElement | undefined;
  if (input) {
    watch(refValue(input), () => {
      schedulePushRoute(tile);
    });
  }
  // 首次行程计划就绪：立即推送一次。
  void pushRouteToFtc(tile);
  subscribe($$(tile.anchor, 'rc-slider'), slider => {
    const label = getSliderLabel(slider);
    if (label) {
      let sliders = tileSliders.get(tile);
      if (!sliders) {
        sliders = new Map();
        tileSliders.set(tile, sliders);
      }
      sliders.set(label, slider);
    }
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

features.add(
  import.meta.url,
  init,
  'SFC：自动把飞船/起终点推送给 FTC 计算最优燃料参数，并把燃料消耗/反应堆使用量设为该参数（未计算过时不改动）。',
);
