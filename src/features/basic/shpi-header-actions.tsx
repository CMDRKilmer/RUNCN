import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { hasMountedUi } from '@src/utils/mount-ui-once';
import $style from './shpi-header-actions.module.css';

// SHPI 窗体内部的「卸货」是游戏原生按钮（StoreView.centered 内第一个 button）。
// 按用户要求把它搬到标题栏右侧、改成 XIT FLT / ETA 列那样的图标按钮：
// 原按钮只在 CSS 里隐藏、节点保留，点图标时程序化触发它的 click()，
// 仍然走游戏原生卸货流程（确认弹窗 + MTRA 批量转移），不自己拼转移数据。
function clickNativeUnload(tile: PrunTile) {
  const centered = tile.frame.querySelector(`.${C.StoreView.centered}`);
  const button = centered?.querySelector('button') as HTMLButtonElement | undefined;
  button?.click();
}

function onTileReady(tile: PrunTile) {
  // FB 面板把内嵌磁贴的 TileFrame.controls（窗口按钮区）整体 display:none，
  // 图标挂在那里会完全看不见；TileFrame.header 在独立窗口和 FB 内嵌磁贴里
  // 都始终可见，且本身是 flex 容器，用 margin-left:auto 就能把按钮推到右侧。
  const header = tile.frame.querySelector(`.${C.TileFrame.header}`);
  if (!header || hasMountedUi(header, 'shpi-header-actions')) {
    return;
  }
  createFragmentApp(() => (
    <div data-rp-ui="shpi-header-actions" class={$style.group}>
      <button
        type="button"
        data-rp-shpi-action="unload"
        class={[$style.button, $style.unload]}
        data-tooltip="卸货"
        data-tooltip-position="bottom"
        onClick={() => clickNativeUnload(tile)}>
        ⭳
      </button>
      <button
        type="button"
        data-rp-shpi-action="flight"
        class={[$style.button, $style.flight]}
        data-tooltip={`打开 SFC ${tile.parameter}`}
        data-tooltip-position="bottom"
        onClick={() => showBuffer(`SFC ${tile.parameter}`)}>
        ✈
      </button>
    </div>
  )).appendTo(header);
}

function init() {
  tiles.observe('SHPI', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'SHPI：标题栏右侧新增卸货 / 起飞（SFC）图标按钮，窗体内部文字卸货按钮隐藏但仍走游戏原生流程。',
);
