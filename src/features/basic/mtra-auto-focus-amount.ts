function onTileReady(tile: PrunTile) {
  if (tile.docked) {
    return;
  }
  subscribe($$(tile.anchor, 'input'), input => {
    if (input.type === 'text') {
      // Use setTimeout because something is messing with focus
      // immediately after input element creation.
      setTimeout(() => {
        input.focus();
        input.select();
      });
    }
  });
}

function init() {
  tiles.observe('MTRA', onTileReady);
}

features.add(import.meta.url, init, 'MTRA：打开缓冲区时自动聚焦数量输入框。');
