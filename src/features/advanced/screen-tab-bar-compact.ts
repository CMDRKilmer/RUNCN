import $style from './screen-tab-bar-compact.module.css';
import { userData } from '@src/store/user-data';

// 「界面」列表里缩短屏幕名、默认收起行内操作按钮属于「缩短 / 隐藏信息」，
// 按 docs/contributing.md 必须放 advanced/，只对 FULL 模式用户生效。
// 多列重排与标签栏本体仍由 basic/screen-tab-bar 提供，两条规则作用于同一个列表。
function init() {
  // feature-registry 从 import.meta.url 的路径推导 advanced 门槛，但生产构建的
  // entryFileNames 把模块拍平成 dist/virtual/<name>.js，路径里的 advanced 段会丢失，
  // 该门槛在打包产物里整体失效（上游既有问题）。补一道显式判断，确保这条
  // 「隐藏信息」规则确实只对 FULL 模式生效；等构建路径修复后可去掉。
  if (userData.settings.mode !== 'FULL') {
    return;
  }
  applyCssRule(`.${C.ScreenControls.screens}`, $style.screensMenuCompact);
}

features.add(import.meta.url, init, '「界面」列表：缩短屏幕名并默认收起行内操作按钮。');
