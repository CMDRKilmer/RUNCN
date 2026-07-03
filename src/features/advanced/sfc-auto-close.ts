import { closeTileWindow } from '@src/infrastructure/prun-ui/utils/close-prun-window';
import { sleep } from '@src/utils/sleep';

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.frame, C.ActionFeedback.success), async () => {
    await sleep(300);
    closeTileWindow(tile);
  });
}

function init() {
  tiles.observe('SFC', onTileReady);
}

features.add(import.meta.url, init, 'SFC：成功后自动关闭窗口。');
