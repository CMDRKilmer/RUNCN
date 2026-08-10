import GeneratePurchaseDraftButton from './GeneratePurchaseDraftButton.vue';

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.Button.btn), () => {
    addButton(tile);
  });
}

function addButton(tile: PrunTile) {
  if (tile.anchor.querySelector('[data-rp-contd-purchase-draft-button]')) {
    return;
  }

  const buttons = _$$(tile.anchor, C.Button.btn);
  const anchor =
    buttons.find(button =>
      /新建|选择模板|保存|create|select template|save/i.test(button.textContent ?? ''),
    ) ?? buttons[0];
  if (anchor === undefined) {
    return;
  }

  createFragmentApp(GeneratePurchaseDraftButton, { tile }).after(anchor);
}

function init() {
  tiles.observe('CONTD', onTileReady);
}

features.add(import.meta.url, init, 'CONTD：根据 ACT JSON 一键生成采购合同草案。');
