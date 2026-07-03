export function closePrunWindow(window: Element | null | undefined) {
  if (!window) {
    return;
  }

  const buttons = _$$(window, C.Window.button);
  const closeButton = buttons.find(x => x.textContent === 'x') as HTMLButtonElement;
  closeButton?.click();
}

export function closeTileWindow(tile: PrunTile) {
  if (tile.docked) {
    return;
  }
  const window = tile.frame.closest(`.${C.Window.window}`);
  closePrunWindow(window);
}
