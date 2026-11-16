// 旋转箭头圆圈的共享驱动：整个页面只起一个定时器，由所有 XIT FLT 实例共用。
// 实例挂载时 acquire、卸载时 release，最后一个实例离开才真正停止定时器。
// 不用 CSS transform 动画：合成层动画只更新纹理，某些窗口状态下计算样式一直在变、
// 屏幕却不重画；直接改写 SVG <g> 的 transform 呈现属性会走主线程光栅化。
// 系统开启「减少动画」时停止更新角度，图标停在当前位置。
const FRAME_MS = 33;
const ROUND_MS = 2400;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const start = performance.now();
let timer: ReturnType<typeof setInterval> | undefined;
let instances = 0;

function tick(): void {
  if (reducedMotion.matches) {
    return;
  }
  const deg = (((performance.now() - start) / ROUND_MS) * 360) % 360;
  for (const layer of document.querySelectorAll('[data-route-spin]')) {
    if (layer.getAttribute('data-flying') === 'true') {
      layer.setAttribute('transform', `rotate(${deg.toFixed(1)} 12 12)`);
    }
  }
}

export function acquireRouteSpin(): void {
  instances += 1;
  if (timer !== undefined) {
    return;
  }
  timer = setInterval(tick, FRAME_MS);
}

export function releaseRouteSpin(): void {
  instances = Math.max(0, instances - 1);
  if (instances === 0 && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
