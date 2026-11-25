// 磁贴内的悬浮提示。
//
// 游戏自带的 `data-tooltip` 是纯 CSS 伪元素（`[data-tooltip]::before`），
// `position: absolute` 挂在元素自己身上、没有 portal，因此会被磁贴的
// 滚动容器 `overflow` 裁掉 —— 表格最后一列、靠边的按钮尤其明显
// （气泡 `min-width: 200px`，从按钮中心向两侧展开，右侧直接出界）。
//
// 这里改成自绘浮层：`position: fixed` 挂到 `document.body`，不受任何
// 磁贴裁剪影响；位置按元素矩形计算，放不下就换到下方，并夹在视口内。

const TOOLTIP_CLASS = 'rp-floating-tooltip';
const GAP = 8;
const MAX_WIDTH = 320;

let tooltip: HTMLDivElement | undefined;

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
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}

/**
 * 给元素挂一个浮层提示。`text` 可以是函数，鼠标进入时再求值（判定会随状态变化）。
 * 返回解绑函数。
 */
export function attachFloatingTooltip(el: HTMLElement, text: () => string): () => void {
  const onEnter = () => {
    const value = text();
    if (value) {
      place(el, value);
    }
  };
  const onLeave = () => hide();

  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mouseleave', onLeave);
  el.addEventListener('focus', onEnter);
  el.addEventListener('blur', onLeave);

  return () => {
    el.removeEventListener('mouseenter', onEnter);
    el.removeEventListener('mouseleave', onLeave);
    el.removeEventListener('focus', onEnter);
    el.removeEventListener('blur', onLeave);
    hide();
  };
}

/** 页面滚走或磁贴重排时把气泡收掉（否则会停在原地）。 */
export function hideFloatingTooltip() {
  hide();
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
