import { onMounted, type WritableComputedRef } from 'vue';
import { useTile } from '@src/hooks/use-tile';
import onNodeDisconnected from '@src/utils/on-node-disconnected';
import { hasMountedUi } from '@src/utils/mount-ui-once';
import $style from './title-bar-toggle.module.css';

interface TitleBarToggleOptions {
  // data-rp-ui 值：验收脚本按它定位按钮，重复判定也用它。
  ui: string;
  // 固定文字，不随状态变化；状态由 data-rp-selected / aria-pressed 表达。
  // 按用户要求不加鼠标浮窗（不用 data-tooltip / title），无障碍名称走 aria-label。
  label: string;
  active: WritableComputedRef<boolean>;
}

// XIT 页面标题栏右侧的固定文字开关，与 XIT FLT「产出装船」同款位置与外观。
// 挂在 frame 上而不是 TileFrame.controls：XIT FB / ABCC 面板会把内嵌磁贴的控件区
// 整个隐藏，挂那里在面板里看不见；frame 自身 position:relative 可绝对定位。
export function useTitleBarToggle(options: TitleBarToggleOptions) {
  const tile = useTile();

  onMounted(() => {
    // 切换标签 / FB 搬移 DOM 会让挂载逻辑重复触发，同一 frame 上只留一个。
    if (hasMountedUi(tile.frame, options.ui)) {
      return;
    }
    createFragmentApp(() => (
      <button
        type="button"
        data-rp-ui={options.ui}
        data-rp-selected={options.active.value ? 'on' : 'off'}
        aria-label={options.label}
        aria-pressed={options.active.value}
        class={[C.Button.btn, C.Button.dark, $style.toggle]}
        onClick={() => (options.active.value = !options.active.value)}>
        {options.label}
      </button>
    )).appendTo(tile.frame);

    // 独立窗口的原生控件可能晚于首帧渲染（窗口首帧、FB 异步搬移）：找不到就按帧
    // 重试（约 2 秒），找到后跟 ResizeObserver 跟踪控件显隐与窗口缩放，把宽度写进
    // --rp-title-controls-width 供 CSS 让位。
    const controlsOf = () => _$(tile.frame, C.TileFrame.controls) as HTMLElement | undefined;
    const measure = (controls: HTMLElement | undefined) => {
      const width = controls === undefined ? 0 : Math.round(controls.getBoundingClientRect().width);
      tile.frame.style.setProperty('--rp-title-controls-width', `${width}px`);
    };

    let retry: number | undefined;
    let observer: ResizeObserver | undefined;
    let attempts = 120;
    const attach = () => {
      retry = undefined;
      const controls = controlsOf();
      measure(controls);
      if (controls === undefined) {
        if (attempts > 0 && tile.anchor.isConnected) {
          attempts -= 1;
          retry = requestAnimationFrame(attach);
        }
        return;
      }
      observer = new ResizeObserver(() => measure(controls));
      observer.observe(controls);
    };
    attach();
    onNodeDisconnected(tile.anchor, () => {
      if (retry !== undefined) {
        cancelAnimationFrame(retry);
      }
      observer?.disconnect();
    });
  });
}
