export function applyThemeAppearance(
  root: HTMLElement,
  settings?: { themeFontSize?: unknown; themeBorders?: unknown },
) {
  if (settings?.themeFontSize === 'standard') {
    root.dataset.rpFontSize = 'standard';
  } else {
    delete root.dataset.rpFontSize;
  }

  const borders = settings?.themeBorders;
  if (borders === 'on' || borders === 'off') {
    root.dataset.rpBorders = borders;
  } else {
    delete root.dataset.rpBorders;
  }
}
