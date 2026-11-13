import { applyRawCssRule } from '@src/infrastructure/prun-ui/refined-prun-css';

// BS 上下文命令行里的 HQ「总部」与 ARC「APEX 代表中心」是游戏原生命令键
// （只读 CDP 实测：ContextControls__item，cmd 文本分别为 HQ / ARC，无 data-rp-*）。
// 这里在 BS 磁贴级订阅上下文项，按命令文本打标，再由一条全局 CSS 规则隐藏。
// 打标而非直接改 inline style：React 重绘替换节点后订阅会重新命中新节点，不会漏。
// 规则由本功能 init() 注入，因此 XIT SET FEAT 里关闭本功能后两个命令键恢复显示。
const MARK = 'data-rp-ui';
const MARK_VALUE = 'bs-context-hidden';
const HIDDEN_CMDS = new Set(['HQ', 'ARC']);

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.frame, C.ContextControls.item), item => {
    const cmd = item.querySelector(`[class*='ContextControls__cmd']`)?.textContent?.trim();
    if (!cmd || !HIDDEN_CMDS.has(cmd)) {
      return;
    }
    item.setAttribute(MARK, MARK_VALUE);
    item.setAttribute('data-rp-bs-hidden-cmd', cmd);
  });
}

function init() {
  // 规则不带主题前缀，所有主题行为一致（沿用 inv-hide-upck 的做法）。
  applyRawCssRule(`[${MARK}='${MARK_VALUE}'] { display: none !important; }`);
  tiles.observe('BS', onTileReady);
}

// 不传 hidden 参数：按原有样式出现在 XIT SET FEAT 的功能列表里，
// 开启 = 隐藏 HQ / ARC，关闭 = 恢复显示，更改后点「重启游戏以应用更改」生效。
features.add(
  import.meta.url,
  init,
  'BS：隐藏上下文菜单里游戏原生的 HQ「总部」与 ARC「APEX 代表中心」命令键，只影响 BS 命令窗口，PLI / INV / BRA 等其它命令键保留。关闭本功能后两个命令键恢复显示。适用于所有主题，以及独立窗口与面板内嵌的基地窗口。',
);
