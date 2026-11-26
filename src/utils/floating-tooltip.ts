// 磁贴内的悬浮提示。
//
// 游戏自带的 `data-tooltip` 是纯 CSS 伪元素（`[data-tooltip]::before`），
// `position: absolute` 挂在元素自己身上、没有 portal，因此会被磁贴的
// 滚动容器 `overflow` 裁掉 —— 表格最后一列、靠边的按钮尤其明显
// （气泡 `min-width: 200px`，从按钮中心向两侧展开，右侧直接出界）。
//
// 这里改成自绘浮层：`position: fixed` 挂到 `document.body`，不受任何
// 磁贴裁剪影响；位置按元素矩形计算，放不下就换到下方，并夹在视口内。

import onNodeDisconnected from '@src/utils/on-node-disconnected';

const TOOLTIP_CLASS = 'rp-floating-tooltip';
const GAP = 8;
const MAX_WIDTH = 320;

let tooltip: HTMLDivElement | undefined;
// 当前气泡是给谁显示的：整页只有一个浮层，谁都不能顺手把别人的气泡收掉
// （悬停 A 之后悬停 B，A 被重渲染摘掉时不能连带隐藏 B 的提示）。
let activeTrigger: HTMLElement | undefined;

function ensureTooltip() {
  if (tooltip?.isConnected) {
    return tooltip;
  }
  tooltip = document.createElement('div');
  tooltip.className = TOOLTIP_CLASS;
  tooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(tooltip);
  return tooltip;
}

function place(el: HTMLElement, text: string) {
  activeTrigger = el;
  watchScroll();
  const box = ensureTooltip();
  box.textContent = text;
  box.style.display = 'block';

  const target = el.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  // 优先放上方；上方放不下（或会超出视口顶）就放下方。
  const fitsAbove = target.top - boxRect.height - GAP >= 0;
  const top = fitsAbove ? target.top - boxRect.height - GAP : target.bottom + GAP;
  // 水平居中，再夹到视口内。
  const centered = target.left + target.width / 2 - boxRect.width / 2;
  const left = Math.min(Math.max(GAP, centered), window.innerWidth - boxRect.width - GAP);

  box.style.top = `${Math.round(top)}px`;
  box.style.left = `${Math.round(left)}px`;
}

function hide() {
  activeTrigger = undefined;
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}

// 只收「属于该元素」的气泡：清理由别的触发元素发起的（它的断开、它的解绑）
// 时，当前悬停的元素还亮着，不能跟着消失。
function hideFor(el: HTMLElement) {
  if (activeTrigger !== el) {
    return;
  }
  hide();
}

/**
 * 给元素挂一个浮层提示。`text` 可以是函数，鼠标进入时再求值（判定会随状态变化）。
 * 返回解绑函数。
 */
// 触发元素被整块摘掉时（React 重渲染、合同状态变化）不会发 mouseleave，
// 气泡会一直停在屏幕上。这里在第一次悬停时给触发元素挂一次「断开即收起」，
// 三个调用方（原生 CONTS、CONT 详情、XIT CONTSS）都不用各自处理。
const watched = new WeakSet<HTMLElement>();

function watchTriggerDisconnect(el: HTMLElement) {
  if (watched.has(el)) {
    return;
  }
  watched.add(el);
  onNodeDisconnected(el, () => {
    // onNodeDisconnected 的回调只消费一次；而磁贴切走再切回时游戏会复用同一批节点
    // （tiles.ts 的 retained frame），若这里不把标记清掉，重新接回后再悬停就不会再登记，
    // 下一次被摘掉时气泡就留在屏幕上。清掉标记，允许重新登记。
    watched.delete(el);
    hideFor(el);
  });
}

export function attachFloatingTooltip(el: HTMLElement, text: () => string): () => void {
  const onEnter = () => {
    watchTriggerDisconnect(el);
    const value = text();
    if (value) {
      place(el, value);
    }
  };
  const onLeave = () => hideFor(el);

  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mouseleave', onLeave);
  el.addEventListener('focus', onEnter);
  el.addEventListener('blur', onLeave);

  return () => {
    el.removeEventListener('mouseenter', onEnter);
    el.removeEventListener('mouseleave', onLeave);
    el.removeEventListener('focus', onEnter);
    el.removeEventListener('blur', onLeave);
    hideFor(el);
  };
}

/** 页面滚走或磁贴重排时把气泡收掉（否则会停在原地）。 */
export function hideFloatingTooltip() {
  hide();
}

// 键盘聚焦（Tab）出来的气泡不依赖鼠标位置：磁贴内容滚动时按钮既不会 blur 也不会
// 断开，`position: fixed` 的气泡会停在旧坐标上盖住别的内容。滚动一律收起 ——
// 用捕获阶段，磁贴内部的滚动容器也能收到。
let watchingScroll = false;

function watchScroll() {
  if (watchingScroll) {
    return;
  }
  watchingScroll = true;
  window.addEventListener('scroll', () => hideFloatingTooltip(), {
    capture: true,
    passive: true,
  });
}

// 一次性注入样式：与游戏自带气泡同款配色，只是定位方式不同。
if (typeof document !== 'undefined' && !document.getElementById('rp-floating-tooltip-style')) {
  const style = document.createElement('style');
  style.id = 'rp-floating-tooltip-style';
  style.textContent = `
.${TOOLTIP_CLASS} {
  position: fixed;
  z-index: 2147483000;
  display: none;
  max-width: ${MAX_WIDTH}px;
  padding: 8px;
  border-radius: 4px;
  border: 2px solid #c48400;
  background: #262626;
  color: #eeeeee;
  font-size: 11px;
  font-weight: normal;
  line-height: 1.3;
  text-align: left;
  pointer-events: none;
  box-sizing: border-box;
}
`;
  document.head.appendChild(style);
}
