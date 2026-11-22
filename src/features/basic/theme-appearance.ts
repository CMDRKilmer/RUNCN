import { isDarkTheme } from './theme-registry';

export function applyThemeAppearance(
  root: HTMLElement,
  settings?: { theme?: unknown; themeFontSize?: unknown; themeBorders?: unknown },
) {
  // 深色标记：CSS 里共享的「染深」覆盖只认 html[data-rp-dark]。首屏与引擎都
  // 调本函数，所以第一帧就带上，不会有浅色染深规则先赢一帧。
  if (typeof settings?.theme === 'string' && isDarkTheme(settings.theme)) {
    root.dataset.rpDark = 'on';
  } else {
    delete root.dataset.rpDark;
  }

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
