import { extractPlanetName } from '@src/core/game-lookups';

function onTileReady(tile: PrunTile) {
  // 仅在主 INV 磁贴中缩短名称
  if (tile.parameter) {
    return;
  }

  subscribe($$(tile.anchor, C.Link.link), link => {
    if (link.textContent) {
      link.textContent = extractPlanetName(link.textContent);
    }
  });
}

function init() {
  tiles.observe('INV', onTileReady);
}

features.add(import.meta.url, init, 'INV：缩短主 INV 命令中的地址。');
