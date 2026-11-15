import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { applyRawCssRule } from '@src/infrastructure/prun-ui/refined-prun-css';
import { hasMountedUi } from '@src/utils/mount-ui-once';
import $style from './shpi-header-actions.module.css';

// SHPI 窗体内部的「卸货」是游戏原生按钮（只读 CDP 实测：Button__primary /
// Button__btn，父链全为 StoreView__row / StoreView__container / TileFrame__anchor，
// 无 data-rp-* 插件标记）。按用户要求把它搬到标题栏右侧、改成图标按钮：
// 原按钮只在 CSS 里隐藏、节点保留，点图标时程序化触发它的 click()，
// 仍然走游戏原生卸货流程（确认弹窗 + MTRA 批量转移），不自己拼转移数据。
// 隐藏规则由本功能的 init() 注入（不再写死在 refined-prun.css 全局），
// 因此 XIT SET FEAT 里禁用本功能后，原生「卸货」按钮会恢复显示。
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
  // 隐藏的是游戏原生按钮，规则必须随本功能开关启停：写在 init() 里由
  // applyRawCssRule 注入（生成 <style id="rp-css-shpi-header-actions">），
  // 禁用本功能时 init 不执行、规则不注入，原生「卸货」按钮自然恢复。
  // 只隐藏 SHPI 命令窗口内部，独立窗口与 XIT FB 面板内嵌的 SHPI 都适用。
  applyRawCssRule(
    `.rp-command-SHPI [class*='StoreView__centered'] > button { display: none !important; }`,
  );
  tiles.observe('SHPI', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'SHPI：标题栏右侧新增卸货 / 起飞（SFC）图标按钮，并隐藏窗体内部游戏原生的文字「卸货」按钮（仍走游戏原生流程）。关闭本功能后，原生文字「卸货」按钮恢复显示、标题栏图标按钮一并移除。适用于独立窗口与 FB 面板内嵌的舰船库存窗口。',
);
