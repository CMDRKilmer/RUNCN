<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

export type TooltipPosition = 'left' | 'right' | 'top' | 'bottom';

const {
  position = 'right',
  tooltip,
  noIcon = false,
} = defineProps<{
  position?: TooltipPosition;
  // 文本为空或 undefined 时不显示气泡;trigger 仍正常工作。
  tooltip?: string;
  // 隐藏默认的 ⓘ 图标。当组件包裹了已有视觉的触发元素(如 cargo bar 段)
  // 时使用,避免图标与触发元素重叠。
  noIcon?: boolean;
}>();

const containerRef = ref<HTMLElement | null>(null);
let el: HTMLDivElement | null = null;
let ro: ResizeObserver | null = null;
let hoveringTarget = false;
let hoveringPortal = false;
let hideTimeout: number | null = null;

function createEl() {
  el = document.createElement('div');
  el.className = 'rp-tooltip-portal';
  el.setAttribute('role', 'tooltip');
  el.style.position = 'fixed';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '2147483647';
  el.style.transition = 'opacity 120ms ease, transform 120ms ease';
  el.style.opacity = '0';
  el.style.background = '#2a2a2a';
  el.style.color = '#fff';
  el.style.padding = '6px 8px';
  el.style.borderRadius = '4px';
  el.style.fontSize = '12px';
  el.style.whiteSpace = 'nowrap';
  el.style.transform = 'translateY(4px)';
  el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
  document.body.appendChild(el);
}

function show() {
  if (!tooltip) {
    return;
  }
  if (!el) {
    createEl();
  }
  if (!el || !containerRef.value) {
    return;
  }
  el.textContent = tooltip;
  const rect = containerRef.value.getBoundingClientRect();
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const tryPositions: TooltipPosition[] = [position, 'top', 'bottom', 'left', 'right'];
  let placed = false;
  // temporarily make visible to measure
  el.style.left = '0px';
  el.style.top = '-9999px';
  el.style.opacity = '0';
  el.style.display = 'block';
  const ew = el.offsetWidth;
  const eh = el.offsetHeight;

  for (const pos of tryPositions) {
    let calcLeft = 0;
    let calcTop = 0;
    if (pos === 'right') {
      calcLeft = rect.right + margin;
      calcTop = rect.top + (rect.height - eh) / 2;
    } else if (pos === 'left') {
      calcLeft = rect.left - ew - margin;
      calcTop = rect.top + (rect.height - eh) / 2;
    } else if (pos === 'top') {
      calcLeft = rect.left + (rect.width - ew) / 2;
      calcTop = rect.top - eh - margin;
    } else {
      calcLeft = rect.left + (rect.width - ew) / 2;
      calcTop = rect.bottom + margin;
    }

    const fitsHoriz = calcLeft >= 0 && calcLeft + ew <= vw;
    const fitsVert = calcTop >= 0 && calcTop + eh <= vh;
    if (fitsHoriz && fitsVert) {
      el.style.left = `${Math.max(4, calcLeft)}px`;
      el.style.top = `${Math.max(4, calcTop)}px`;
      placed = true;
      break;
    }
  }

  if (!placed) {
    const calcLeft = Math.min(Math.max(4, rect.left + (rect.width - ew) / 2), vw - ew - 4);
    const calcTop = Math.min(Math.max(4, rect.bottom + margin), vh - eh - 4);
    el.style.left = `${calcLeft}px`;
    el.style.top = `${calcTop}px`;
  }

  // If a hide was scheduled, cancel it
  if (hideTimeout !== null) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  requestAnimationFrame(() => {
    if (!el) {
      return;
    }
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    el.style.pointerEvents = 'auto';
  });
}

function scheduleHide(delay = 80) {
  if (hideTimeout !== null) {
    clearTimeout(hideTimeout);
  }
  hideTimeout = window.setTimeout(() => {
    if (hoveringTarget || hoveringPortal) {
      hideTimeout = null;
      return;
    }
    if (!el) {
      return;
    }
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    el.style.pointerEvents = 'none';
    hideTimeout = null;
  }, delay);
}

function hide() {
  // immediate hide (used for blur/scroll/resize)
  if (hideTimeout !== null) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  if (!el) {
    return;
  }
  el.style.opacity = '0';
  el.style.transform = 'translateY(4px)';
  el.style.pointerEvents = 'none';
}

function removeEl() {
  if (el && el.parentElement) {
    el.parentElement.removeChild(el);
  }
  el = null;
}

onMounted(() => {
  const node = containerRef.value;
  if (!node) {
    return;
  }
  node.addEventListener('mouseenter', () => {
    hoveringTarget = true;
    show();
  });
  node.addEventListener('mouseleave', () => {
    hoveringTarget = false;
    scheduleHide();
  });
  node.addEventListener('focus', () => {
    hoveringTarget = true;
    show();
  });
  node.addEventListener('blur', () => {
    hoveringTarget = false;
    scheduleHide(0);
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  ro = new ResizeObserver(hide);
  ro.observe(node);
  // attach portal listeners when created
  if (el) {
    el.addEventListener('mouseenter', () => {
      hoveringPortal = true;
      if (hideTimeout !== null) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
    });
    el.addEventListener('mouseleave', () => {
      hoveringPortal = false;
      scheduleHide();
    });
  }
});

onBeforeUnmount(() => {
  const node = containerRef.value;
  if (node) {
    node.removeEventListener('mouseenter', show);
    node.removeEventListener('mouseleave', hide);
    node.removeEventListener('focus', show);
    node.removeEventListener('blur', hide);
  }
  window.removeEventListener('scroll', hide, true);
  window.removeEventListener('resize', hide);
  if (ro) {
    ro.disconnect();
  }
  removeEl();
});
</script>

<template>
  <span ref="containerRef" class="rp-tooltip-container" tabindex="0" aria-hidden="false">
    <slot v-if="$slots.default || noIcon" />
    <span v-else class="rp-tooltip-icon">ⓘ</span>
  </span>
</template>

<style>
/* Inline icon styles; tooltip itself is rendered into document.body */
.rp-tooltip-container {
  display: inline-block;
  position: relative;
}
.rp-tooltip-icon {
  font-size: 12px;
  line-height: 1;
  color: #999;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}
.rp-tooltip-portal {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}
</style>
