import TileControlsButton from '@src/components/TileControlsButton.vue';
import { computedTileState } from '@src/store/user-data-tiles';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import css from '@src/utils/css-utils.module.css';
import { getTileState as getBaseTileState } from '@src/store/user-data-tiles';
import fa from '@src/utils/font-awesome.module.css';
import { hasMountedUi, mountOnce } from '@src/utils/mount-ui-once';

interface TileState extends UserData.TileState {
  minimizeContextControls: boolean;
}

function getTileState(tile: PrunTile) {
  return computed(() => getBaseTileState(tile) as TileState);
}

async function onTileReady(tile: PrunTile) {
  const tileContextControls = await $(tile.frame, C.ContextControls.container);

  const isMinimized = computedTileState(getTileState(tile), 'minimizeContextControls', false);
  watchEffectWhileNodeAlive(tile.anchor, () => {
    tileContextControls.classList.toggle(css.hidden, isMinimized.value);
  });

  const tileControls = await $(tile.frame, C.TileFrame.controls);
  // 上下文命令行上的隐藏眼睛图标、标题栏上的恢复按钮，都只注入一次。
  // 切标签回来 / 扩展热重载时会重复触发 observer，否则这里会出现多个眼睛图标。
  mountOnce(tileControls, 'hide-controls-restore', () => {
    createFragmentApp(() =>
      isMinimized.value ? (
        <TileControlsButton
          icon={'\uf0c9'}
          marginTop={4}
          onClick={() => (isMinimized.value = false)}
        />
      ) : null,
    ).prependTo(tileControls);
  });

  if (hasMountedUi(tileContextControls, 'hide-controls')) {
    return;
  }
  createFragmentApp(() => (
    <>
      <div
        data-rp-ui="hide-controls"
        class={[C.ContextControls.item, C.fonts.fontRegular, C.type.typeSmall]}
        onClick={() => {
          isMinimized.value = true;
        }}>
        <i class={[fa.solid]}>{'\uf070'}</i>
      </div>
      <div data-rp-ui="hide-controls-spacer" style={{ flexGrow: '1' }} />
    </>
  )).prependTo(tileContextControls);
}

function init() {
  tiles.observeAll(onTileReady);
}

features.add(import.meta.url, init, '添加按钮来隐藏和显示包含上下文控件的磁贴。');
