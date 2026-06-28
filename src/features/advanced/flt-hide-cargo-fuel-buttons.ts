import css from '@src/utils/css-utils.module.css';

const BUTTON_TEXTS = new Set(['货物', '燃料', 'Cargo', 'Fuel']);

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, 'tr'), row => onRowReady(row as HTMLTableRowElement));
}

function onRowReady(row: HTMLTableRowElement) {
  const commandsCell = row.lastElementChild;
  if (!(commandsCell instanceof HTMLElement)) {
    return;
  }
  if (commandsCell.dataset.rprunHideCargoFuel === '1') {
    return;
  }
  for (const btn of _$$(commandsCell, 'button')) {
    const text = btn.textContent?.trim() ?? '';
    if (BUTTON_TEXTS.has(text)) {
      btn.classList.add(css.hidden);
    }
  }
  commandsCell.dataset.rprunHideCargoFuel = '1';
}

function init() {
  tiles.observe(['FLT', 'FLTS', 'FLTP'], onTileReady);
}

features.add(import.meta.url, init, 'FLT：隐藏指令列中的"货物"和"燃料"按钮。');
