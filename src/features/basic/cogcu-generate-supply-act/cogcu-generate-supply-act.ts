import GenerateSupplyActButton from './GenerateSupplyActButton.vue';

async function onTileReady(tile: PrunTile) {
  const contribute = await $(tile.anchor, C.Contribution.contribute);
  createFragmentApp(GenerateSupplyActButton, { planet: tile.parameter }).after(contribute);
}

function init() {
  tiles.observe('COGCU', onTileReady);
}

features.add(import.meta.url, init, 'COGCU：在贡献区旁添加生成补给 ACT 包的按钮。');
