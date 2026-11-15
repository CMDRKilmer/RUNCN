import { applyRawCssRule } from '@src/infrastructure/prun-ui/refined-prun-css';

// INV 上下文命令行里的 UPCK 是游戏原生命令（「UPCK <仓库 id>: 拆包」），
// 没有 data 属性可挂选择器。这里在磁贴级订阅上下文项，按命令文本打标，
// 再由一条全局 CSS 规则隐藏。打标而非直接改 inline style：React 重绘替换
// 节点后订阅会重新命中新节点，不会漏；CSS 规则不带主题前缀，因此原样主题
// 与其它主题行为一致。
//
// 放在 advanced/：本功能隐藏游戏原生信息，按 docs/contributing.md「移除、缩短或隐藏
// 信息的功能放 advanced/」的要求归入高级模式（非 FULL 模式不加载，原生命令保留）。
const MARK = 'data-rp-ui';
const MARK_VALUE = 'inv-upck-hidden';

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.frame, C.ContextControls.item), item => {
    const cmd = item.querySelector(`[class*='ContextControls__cmd']`);
    if (cmd?.textContent?.trim() !== 'UPCK') {
      return;
    }
    item.setAttribute(MARK, MARK_VALUE);
  });
}

function init() {
  applyRawCssRule(`[${MARK}='${MARK_VALUE}'] { display: none !important; }`);
  tiles.observe('INV', onTileReady);
}

// 不传 hidden 参数：本功能按原有样式出现在 XIT SET FEAT 的功能列表里，
// 由该页的通用启停开关控制（开启 = 隐藏 UPCK，关闭 = 恢复显示），
// 与列表内其它功能一样在更改后点「重启游戏以应用更改」生效。
features.add(
  import.meta.url,
  init,
  'INV：隐藏上下文菜单里原生的 UPCK「拆包」命令，关闭本功能后恢复显示。适用于所有主题，以及独立窗口与 FB 面板内嵌的库存窗口。',
);
