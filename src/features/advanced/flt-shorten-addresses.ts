import { extractPlanetName } from '@src/core/game-lookups';

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.Link.link), link => {
    if (link.textContent) {
      link.textContent = extractPlanetName(link.textContent);
    }
  });
}

function init() {
  tiles.observe(['FLT', 'FLTS', 'FLTP'], onTileReady);
}

features.add(import.meta.url, init, 'FLT：缩短"位置"和"目的地"中的地址。');
