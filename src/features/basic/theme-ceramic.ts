// 陶瓷白多彩主题（ceramic-colorful）—— 主题引擎侧。
//
// 这里不保存任何颜色字面量：皮肤的全部颜色在运行时从 refined-prun.css 的
// --rp-cc-* token 读取（getComputedStyle），因此色板只有一处定义。
// 本文件负责两件事：
//   1) buildCeramicSkin()：把 token 组装成 theme.ts 需要的 Skin，使样式表扫描
//      重映射能按 8 个色相带输出「多彩但同类同色」的颜色；
//   2) CERAMIC_CSS 的组件类型 → token 映射骨架：由 buildComponentCss(themeId)
//      按主题 id 生成，全部带 html[data-rp-theme='<id>'][data-rp-theme] 前缀，
//      不触碰其它主题。骨架本身与颜色无关，token 模式的新主题可直接复用。
//      重复一次 [data-rp-theme] 是为了把特异性抬到 (0,3,1)：
//      refined-prun.css 由 startup 挂在 <html> 末尾的容器里，文档顺序晚于
//      <head> 里的 #rprun-theme，同特异性时会反过来压掉本主题的窗口描边；
//      CONTROL_CSS 的 primary 按钮规则也带两个属性选择器。加这一级即可压过。
import type { Skin } from './theme';
import { CERAMIC_THEME_ID } from './theme-registry';

export { CERAMIC_THEME_ID };

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToTriple(hex: string): string {
  const m = hex.match(/^#([\da-f]{6})$/i);
  if (!m) {
    return '51, 86, 111';
  }
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).join(', ');
}

// 画布是否足够暗，用来判定「深色主题」——决定中性色文字的映射方向（见 theme.ts）。
function isDarkColor(hex: string): boolean {
  const m = hex.match(/^#([\da-f]{6})$/i);
  if (!m) {
    return false;
  }
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  // 相对亮度近似；< 90 视为深色主题（ceramic 的暖白画布远高于此）。
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 90;
}

function band(index: number) {
  const prefix = `--rp-cc-cat-${index}-`;
  return {
    text: token(`${prefix}text`),
    background: token(`${prefix}bg`),
    gradient: [token(`${prefix}bg`), token(`${prefix}border`)] as [string, string],
    border: token(`${prefix}border`),
  };
}

// 8 个色相带按 hue 顺序排列，key 与 theme.ts 的 bandKeyOf() 一致。
// 同一 hue 的游戏原生彩色（图表、状态块、图标、装饰）全站映射到同一色带，
// 不会出现「每个卡片随机配色」。
export function ceramicHueBands() {
  return {
    rose: band(8),
    amber: band(4),
    olive: band(3),
    teal: band(2),
    cyan: band(1),
    blue: band(7),
    violet: band(6),
    plum: band(5),
  };
}

export function buildCeramicSkin(): Skin {
  const accent = token('--rp-cc-accent-line');
  const canvas = token('--rp-cc-canvas');
  const isDark = isDarkColor(canvas);
  return {
    // 深色主题判定（画布亮度），决定中性色映射方向；浅色主题为 false，行为不变。
    darkText: isDark,
    // 别名指回语义 token：现有组件和 CONTROL_CSS 里的 --rp-skin-* 无需改动。
    vars: {
      '--rp-skin-bg': 'var(--rp-cc-canvas)',
      '--rp-skin-bg-image': 'none',
      '--rp-skin-panel': 'var(--rp-cc-surface-alt)',
      '--rp-skin-panel-strong': 'var(--rp-cc-surface-alt)',
      '--rp-skin-hover': 'var(--rp-cc-table-row-hover)',
      '--rp-skin-border': 'var(--rp-cc-border-subtle)',
      '--rp-skin-border-strong': 'var(--rp-cc-border-strong)',
      '--rp-skin-ink': 'var(--rp-cc-text-primary)',
      '--rp-skin-muted': 'var(--rp-cc-text-secondary)',
      '--rp-skin-disabled': 'var(--rp-cc-text-disabled)',
      '--rp-skin-disabled-bg': 'var(--rp-cc-btn-disabled-bg)',
      '--rp-skin-disabled-border': 'var(--rp-cc-btn-disabled-border)',
      '--rp-skin-icon-a': 'var(--rp-cc-surface)',
      '--rp-skin-icon-b': 'var(--rp-cc-cat-1-bg)',
      '--rp-skin-icon-border': 'var(--rp-cc-border-default)',
      '--rp-skin-input-bg': 'var(--rp-cc-control-bg)',
      '--rp-skin-indicator-bg': 'var(--rp-cc-surface)',
      '--rp-skin-active-bg': 'var(--rp-cc-table-row-selected)',
      '--rp-skin-scroll-thumb': 'var(--rp-cc-border-default)',
      '--rp-skin-selection': 'var(--rp-cc-text-link)',
      '--rp-skin-eta': 'var(--rp-cc-text-link)',
      '--rp-skin-eta-sub': 'var(--rp-cc-text-muted)',
      '--rp-skin-action-unload': 'var(--rp-cc-cat-4-text)',
      '--rp-skin-action-flight': 'var(--rp-cc-cat-2-text)',
      '--rp-skin-action-fuel': 'var(--rp-cc-cat-5-text)',
      // 缺料/危险语义红（R27）：BRA「所需材料」不足的数量角标。
      '--rp-skin-danger': 'var(--rp-cc-status-danger-text)',
      '--rp-skin-action-done': 'var(--rp-cc-cat-6-text)',
      // SFC 燃料条专用全深度色：直接取 cat-1 / cat-2 图表实色，
      // 与 R33 的 --rp-cc-progress-*（减半浅色，供 FLT 大燃料条）分离。
      '--rp-skin-sfc-fuel-stl': 'var(--rp-cc-cat-1-chart)',
      '--rp-skin-sfc-fuel-ftl': 'var(--rp-cc-cat-2-chart)',
      '--rp-accent-rgb': hexToTriple(accent),
      '--rp-color-accent-primary': 'var(--rp-cc-accent-line)',
      '--rp-color-text': 'var(--rp-cc-text-primary)',
      '--rp-color-text-component': 'var(--rp-cc-text-primary)',
      '--rp-color-disabled': 'var(--rp-cc-text-disabled)',
    },
    // 三族回退：万一某个色带 token 读不到，仍按语义收敛而不是漏成原色。
    palette: {
      slate: band(7),
      red: band(5),
      green: band(2),
    },
    hueBands: ceramicHueBands(),
    // 中性灰偏移：浅色主题暖调 [2,1,-4]（暖纸）；深色主题改冷蓝 [-4,0,10]，
    // 否则所有中性底/边框都会被偏成棕色（引擎按中性色重映射，如侧栏 #14130e、
    // FB 面板 #12110c、表格空行线），与深空冷底完全不搭。
    neutralShift: isDark ? [-4, 0, 10] : [2, 1, -4],
    status: {
      warning: {
        background: token('--rp-cc-status-warning-bg'),
        text: token('--rp-cc-status-warning-text'),
        border: token('--rp-cc-status-warning-border'),
      },
      danger: {
        background: token('--rp-cc-status-danger-bg'),
        text: token('--rp-cc-status-danger-text'),
        border: token('--rp-cc-status-danger-border'),
      },
    },
    indicator: {
      active: 'var(--rp-cc-control-checked)',
      idle: 'var(--rp-cc-control-track)',
      success: 'var(--rp-cc-status-success-text)',
      danger: 'var(--rp-cc-status-danger-text)',
      glow: accent,
      line: accent,
      lineSoft: accent,
    },
    progress: {
      // 主/次填充用减半深度的专用 token（R33），与图表 cat-1/cat-2 实色分离。
      primary: token('--rp-cc-progress-primary'),
      secondary: token('--rp-cc-progress-secondary'),
      warning: token('--rp-cc-status-warning-text'),
      success: token('--rp-cc-status-success-text'),
      danger: token('--rp-cc-status-danger-text'),
      track: token('--rp-cc-control-track'),
      border: token('--rp-cc-border-default'),
    },
  };
}

// 组件类型 → token 的映射骨架。所有选择器都限定在传入的主题下，颜色一律 var()。
// 顺序在 CONTROL_CSS 之后，因此同特异性时由这里决定按钮/控件的最终外观。
// 骨架与颜色无关：token 模式的新主题只要在 refined-prun.css 里定义同名
// --rp-cc-* 色板，调用 buildComponentCss(<id>) 即可整套复用，无需复制本段。
function componentCssFor(themeId: string): string {
  const P = `html[data-rp-theme='${themeId}'][data-rp-theme]`;
  return `
${P} body {
  background-color: var(--rp-cc-canvas) !important;
  background-image: none !important;
  color: var(--rp-cc-text-primary) !important;
}

/* ── 焦点：所有可交互元素共用同一个可见焦点环（≥3:1） ───────────────── */
${P} :is(button, a, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: var(--rp-cc-ring-width) solid var(--rp-cc-ring) !important;
  outline-offset: var(--rp-cc-ring-offset) !important;
  box-shadow: 0 0 0 4px var(--rp-cc-ring-halo) !important;
}

/* ── 文字层级：标题/正文/辅助/链接/禁用各用固定 token ────────────────── */
${P} :is(h1, h2, h3, h4, h5, h6, p, label, small, th, td, li) {
  color: var(--rp-cc-text-primary);
}
${P} :is(p, small, label, [class*='Label__'], [class*='HeadItem__label']) {
  color: var(--rp-cc-text-secondary);
}
${P} :is([class*='Link__link'], a[href]) {
  color: var(--rp-cc-text-link);
  text-decoration-color: var(--rp-cc-text-link);
}
${P} :is([disabled], [class*='disabled'], [class*='Disabled']) {
  color: var(--rp-cc-text-disabled) !important;
}
${P} :is(a[href], [class*='Link__link']):hover {
  color: var(--rp-cc-btn-link-hover);
}
${P} ::placeholder {
  color: var(--rp-cc-control-placeholder);
  opacity: 1;
}

/* ── 按钮：类型级统一，跨页面同色；五种状态都可辨 ────────────────────── */
${P} [class*='Button__btn'] {
  color: var(--rp-cc-btn-secondary-text) !important;
  background-color: var(--rp-cc-btn-secondary-bg) !important;
  border: 1px solid var(--rp-cc-border-default) !important;
  border-radius: 3px;
  box-sizing: border-box;
  font-weight: 600;
}
${P} [class*='Button__btn']:hover {
  background-color: var(--rp-cc-btn-secondary-hover) !important;
  border-color: var(--rp-cc-border-strong) !important;
}
${P} [class*='Button__btn']:active {
  background-color: var(--rp-cc-btn-secondary-active) !important;
}
${P} :is([class*='Button__primary'], [data-rp-btn='primary']) {
  color: var(--rp-cc-btn-primary-text) !important;
  background-color: var(--rp-cc-btn-primary-bg) !important;
  border-color: var(--rp-cc-btn-primary-border) !important;
}
${P} :is([class*='Button__primary'], [data-rp-btn='primary']):hover {
  background-color: var(--rp-cc-btn-primary-hover) !important;
}
${P} :is([class*='Button__primary'], [data-rp-btn='primary']):active {
  background-color: var(--rp-cc-btn-primary-active) !important;
}
${P} :is([class*='Button__success'], [data-rp-btn='success']) {
  color: var(--rp-cc-status-success-text) !important;
  background-color: var(--rp-cc-status-success-bg) !important;
  border-color: var(--rp-cc-status-success-border) !important;
}
${P} :is([class*='Button__success'], [data-rp-btn='success']):hover {
  background-color: var(--rp-cc-status-success-border) !important;
}
${P} :is([class*='Button__success'], [data-rp-btn='success']):active {
  color: #fffdf8 !important;
  background-color: var(--rp-cc-status-success-text) !important;
}
${P} :is([class*='Button__danger'], [class*='Button__delete'], [data-rp-btn='danger']) {
  color: var(--rp-cc-status-danger-text) !important;
  background-color: var(--rp-cc-status-danger-bg) !important;
  border-color: var(--rp-cc-status-danger-border) !important;
}
${P} :is([class*='Button__danger'], [class*='Button__delete'], [data-rp-btn='danger']):hover {
  background-color: var(--rp-cc-status-danger-border) !important;
}
${P} :is([class*='Button__danger'], [class*='Button__delete'], [data-rp-btn='danger']):active {
  color: #fffdf8 !important;
  background-color: var(--rp-cc-status-danger-text) !important;
}
${P} :is([class*='Button__ghost'], [data-rp-btn='ghost']) {
  color: var(--rp-cc-btn-ghost-text) !important;
  background-color: var(--rp-cc-btn-ghost-bg) !important;
  border-color: var(--rp-cc-btn-ghost-border) !important;
}
${P} :is([class*='Button__ghost'], [data-rp-btn='ghost']):hover {
  background-color: var(--rp-cc-btn-ghost-hover) !important;
}
${P} :is([class*='Button__ghost'], [data-rp-btn='ghost']):active {
  background-color: var(--rp-cc-btn-ghost-active) !important;
}
${P} :is([class*='Button__link'], [data-rp-btn='link']) {
  color: var(--rp-cc-btn-link-text) !important;
  background-color: var(--rp-cc-btn-link-bg) !important;
  border-color: var(--rp-cc-btn-link-border) !important;
  text-decoration: underline;
  text-underline-offset: 2px;
}
${P} :is([class*='Button__link'], [data-rp-btn='link']):hover {
  background-color: var(--rp-cc-btn-link-hover) !important;
}
${P} :is([class*='Button__link'], [data-rp-btn='link']):active {
  background-color: var(--rp-cc-btn-link-active) !important;
}
${P} :is(button:disabled, [class*='Button__disabled'], [aria-disabled='true']) {
  color: var(--rp-cc-btn-disabled-text) !important;
  background-color: var(--rp-cc-btn-disabled-bg) !important;
  border-color: var(--rp-cc-btn-disabled-border) !important;
  opacity: 1 !important;
  cursor: not-allowed;
}

/* ── 表单控件：input/select/textarea/复选/单选/开关/滑块同一套 token ──── */
${P} :is(input, select, textarea, option) {
  color: var(--rp-cc-control-text) !important;
  background-color: var(--rp-cc-control-bg) !important;
  border: 1px solid var(--rp-cc-border-default) !important;
  border-radius: 3px;
  box-sizing: border-box;
}
${P} :is(input, select, textarea):hover {
  border-color: var(--rp-cc-border-strong) !important;
}
${P} :is(input, select, textarea):focus,
${P} :is(input, select, textarea):focus-visible {
  border-color: var(--rp-cc-control-focus) !important;
}
${P} :is(input, select, textarea):disabled {
  color: var(--rp-cc-control-disabled-text) !important;
  background-color: var(--rp-cc-control-disabled-bg) !important;
  border-color: var(--rp-cc-border-subtle) !important;
}
${P} :is(input[type='checkbox'], input[type='radio']) {
  accent-color: var(--rp-cc-control-checked);
  border-color: var(--rp-cc-border-strong) !important;
}
${P} :is(input[type='range'], [class*='Slider__'], [class*='rc-slider']) {
  accent-color: var(--rp-cc-control-thumb);
}
${P} input[type='range'] {
  background-color: var(--rp-cc-control-track) !important;
}
${P} :is([class*='Toggle__'], [class*='Switch__'], [role='switch']) {
  color: var(--rp-cc-control-text) !important;
  border-color: var(--rp-cc-border-default) !important;
}
${P} :is([class*='Toggle__'], [class*='Switch__'], [role='switch'])[aria-checked='true'] {
  background-color: var(--rp-cc-control-checked) !important;
  color: var(--rp-cc-text-inverse) !important;
}
${P} :is([class*='FormComponent__container'], [class*='forms__form-component']) {
  background-color: var(--rp-cc-surface) !important;
  border-bottom-color: var(--rp-cc-table-border) !important;
}
${P} [class*='FormComponent__containerActive'] {
  background-color: var(--rp-cc-table-row-selected) !important;
}

/* ── 卡片 / 窗口 / 弹窗 / 遮罩 ─────────────────────────────────────── */
${P} :is([class*='TileFrame__frame'], [class*='Window__window']) {
  background-color: var(--rp-cc-surface) !important;
  /* 游戏原生窗口外壳是 repeating-linear-gradient 深色斜纹，重映射成浅灰后
     仍是一条条斑马纹；连背景图一起清掉，只留纯色 + 阴影。 */
  background-image: none !important;
  color: var(--rp-cc-text-primary) !important;
  box-shadow: var(--rp-cc-shadow-card) !important;
}
${P} [class*='TileFrame__frame'] {
  border: 1px solid var(--rp-cc-border-subtle) !important;
}
${P} [class*='Window__window'] {
  /* 绝不能用 border：窗口宽高由游戏 inline style 精确控制，多 2px 实边框
     会把内容区从 428px 挤到 426px，XIT SET THEME 的
     repeat(auto-fit, minmax(210px, 1fr)) 就刚好放不下两列而塌成单列。
     层级边界一律用不占盒模型的 box-shadow 表达。 */
  border: 0 !important;
}
${P}:where(:not([data-rp-borders='off'])) [class*='Window__window'] {
  box-shadow: 0 0 0 1px var(--rp-cc-border-default), var(--rp-cc-shadow-card) !important;
}
${P} [class*='Window__header'] {
  background-color: var(--rp-cc-surface-alt) !important;
}
${P}:where(:not([data-rp-borders='off'])) [class*='Window__header'] {
  box-shadow: inset 0 -2px 0 0 var(--rp-cc-accent-line) !important;
}
${P} :is([class*='Overlay__overlay'], [class*='Modal__backdrop'], [class*='Dialog__backdrop']) {
  background-color: var(--rp-cc-overlay) !important;
}
${P} :is([class*='Overlay__children'], [class*='Modal__content'], [class*='Dialog__content']) {
  background-color: var(--rp-cc-surface) !important;
  color: var(--rp-cc-text-primary) !important;
  border: 1px solid var(--rp-cc-border-default) !important;
  box-shadow: var(--rp-cc-shadow-popover) !important;
}

/* ── 表格：表头、低对比斑马纹、等宽数字、hover / 选中 ─────────────────── */
${P} table {
  background-color: var(--rp-cc-table-row) !important;
  color: var(--rp-cc-table-text) !important;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
}
/* 正负语义色类可能直接挂在 td 上（XIT FINBS 的变动百分比），而原生 FIN 的
   同类数字挂在 span 上。若这里把 td/th 的 color 一律改成中性表格文字色，
   前者会被压成中性灰、后者仍是语义绿/红，两类财务窗口的数字颜色就分裂了。
   因此带 ColoredValue 类的单元格不覆盖文字色（保留主题引擎重映射后的语义色），
   底线与等宽数字仍照常统一。 */
${P} :is(td, th):not([class*='ColoredValue']) {
  color: var(--rp-cc-table-text) !important;
}
${P} :is(td, th) {
  font-variant-numeric: tabular-nums;
}
${P}:where(:not([data-rp-borders='off'])) :is(td, th) {
  border-bottom: 1px solid var(--rp-cc-table-border) !important;
}
${P} :is(thead, th, [class*='Table__header']) {
  background-color: var(--rp-cc-table-head-bg) !important;
  color: var(--rp-cc-table-head-text) !important;
  font-weight: 600;
}
${P} tbody tr:nth-child(even) {
  background-color: var(--rp-cc-table-row-alt) !important;
}
${P} tbody tr:hover {
  background-color: var(--rp-cc-table-row-hover) !important;
}
${P} :is(tr[class*='selected'], tr[class*='Selected'], [class*='Table__selected']) {
  background-color: var(--rp-cc-table-row-selected) !important;
}
${P} :is([class*='Pagination__'], [class*='Selections__selection']) {
  color: var(--rp-cc-text-primary) !important;
  border-color: var(--rp-cc-border-default) !important;
}

/* ── Tooltip / 提示：只给真正的浮窗深底浅字 ───────────────────────────
   游戏原生 [class*='Tooltip__container'] 是「ⓘ / ❗ 带圈说明图标」本身，
   不是浮窗。以前把它和浮窗一起染成 --rp-cc-tooltip-bg 深底，图标就变成
   一块黑底，用户明确要求恢复。游戏自己的 [data-tooltip] 伪元素浮窗由
   主题引擎重映射成浅底深字，本身就可读，这里不接管，避免引入新变化。
   伪元素也不能写进 :is()（会让该分支整条失效），所以只列实体容器。 */
${P} .rp-tooltip-portal {
  color: var(--rp-cc-tooltip-text) !important;
  background-color: var(--rp-cc-tooltip-bg) !important;
  border: 1px solid var(--rp-cc-tooltip-border) !important;
  box-shadow: var(--rp-cc-shadow-popover) !important;
  opacity: 1;
}
/* 说明图标保持无底色：显式压掉可能被其它规则带来的深底 / 描边。 */
${P} :is([class*='Tooltip__container'], .rp-tooltip-icon, [class*='Tooltip__icon']) {
  background-color: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  color: var(--rp-cc-text-muted) !important;
}

/* ── 进度条 / 资源条：轨道与填充都由 token 决定 ──────────────────────── */
${P} progress,
${P} [class*='ProgressBar__progress'] {
  background-color: var(--rp-cc-control-track) !important;
  border: 1px solid var(--rp-cc-border-default) !important;
  color: var(--rp-cc-cat-1-chart);
}
${P} progress::-webkit-progress-bar {
  background-color: var(--rp-cc-control-track) !important;
}
${P} :is([class*='ProgressBar__good'], [class*='ProgressBar__primary'])::-webkit-progress-value {
  background-color: var(--rp-cc-progress-primary) !important;
}
${P} [class*='ProgressBar__warning']::-webkit-progress-value {
  background-color: var(--rp-cc-status-warning-text) !important;
}
${P} [class*='ProgressBar__danger']::-webkit-progress-value {
  background-color: var(--rp-cc-status-danger-text) !important;
}

/* ── 状态提示：底色 + 深字 + 边框，并可用 data-rp-status 配图标 ──────── */
${P} :is([class*='daysWarning'], [data-rp-status='warning']) {
  background-color: var(--rp-cc-status-warning-bg) !important;
  color: var(--rp-cc-status-warning-text) !important;
  border-color: var(--rp-cc-status-warning-border) !important;
}
${P} :is([class*='daysMissing'], [data-rp-status='danger'], [class*='Alert__danger']) {
  background-color: var(--rp-cc-status-danger-bg) !important;
  color: var(--rp-cc-status-danger-text) !important;
  border-color: var(--rp-cc-status-danger-border) !important;
}
${P} [data-rp-status='success'] {
  background-color: var(--rp-cc-status-success-bg) !important;
  color: var(--rp-cc-status-success-text) !important;
  border-color: var(--rp-cc-status-success-border) !important;
}
${P} [data-rp-status='info'] {
  background-color: var(--rp-cc-status-info-bg) !important;
  color: var(--rp-cc-status-info-text) !important;
  border-color: var(--rp-cc-status-info-border) !important;
}
${P} [data-rp-status]::before {
  font-weight: 700;
  margin-right: 4px;
}
${P} [data-rp-status='success']::before { content: '\\2713'; }
${P} [data-rp-status='warning']::before { content: '\\26A0'; }
${P} [data-rp-status='danger']::before { content: '\\2715'; }
${P} [data-rp-status='info']::before { content: 'i'; }

/* ── 分类标签：浅底 + 深字；同一 data-label / data-rp-cat 全站同色 ───── */
${P} :is([class*='SectionHeader__container'][data-label], [class*='Tag__'], [class*='Badge__'], [data-rp-cat]) {
  background-color: var(--rp-cc-cat-1-bg) !important;
  color: var(--rp-cc-cat-1-text) !important;
  border-color: var(--rp-cc-cat-1-border) !important;
}
${P} [data-label='Outputs'] { --rp-cc-cat-bg: var(--rp-cc-cat-2-bg); --rp-cc-cat-fg: var(--rp-cc-cat-2-text); --rp-cc-cat-line: var(--rp-cc-cat-2-border); --rp-cc-cat-mark: var(--rp-cc-cat-2-chart); }
${P} [data-label='Inputs'] { --rp-cc-cat-bg: var(--rp-cc-cat-4-bg); --rp-cc-cat-fg: var(--rp-cc-cat-4-text); --rp-cc-cat-line: var(--rp-cc-cat-4-border); --rp-cc-cat-mark: var(--rp-cc-cat-4-chart); }
${P} [data-label='Consumables'] { --rp-cc-cat-bg: var(--rp-cc-cat-5-bg); --rp-cc-cat-fg: var(--rp-cc-cat-5-text); --rp-cc-cat-line: var(--rp-cc-cat-5-border); --rp-cc-cat-mark: var(--rp-cc-cat-5-chart); }
${P} :is([data-label='其他'], [data-label='Other']) { --rp-cc-cat-bg: var(--rp-cc-cat-7-bg); --rp-cc-cat-fg: var(--rp-cc-cat-7-text); --rp-cc-cat-line: var(--rp-cc-cat-7-border); --rp-cc-cat-mark: var(--rp-cc-cat-7-chart); }
${P} [data-rp-cat='1'] { --rp-cc-cat-bg: var(--rp-cc-cat-1-bg); --rp-cc-cat-fg: var(--rp-cc-cat-1-text); --rp-cc-cat-line: var(--rp-cc-cat-1-border); --rp-cc-cat-mark: var(--rp-cc-cat-1-chart); }
${P} [data-rp-cat='2'] { --rp-cc-cat-bg: var(--rp-cc-cat-2-bg); --rp-cc-cat-fg: var(--rp-cc-cat-2-text); --rp-cc-cat-line: var(--rp-cc-cat-2-border); --rp-cc-cat-mark: var(--rp-cc-cat-2-chart); }
${P} [data-rp-cat='3'] { --rp-cc-cat-bg: var(--rp-cc-cat-3-bg); --rp-cc-cat-fg: var(--rp-cc-cat-3-text); --rp-cc-cat-line: var(--rp-cc-cat-3-border); --rp-cc-cat-mark: var(--rp-cc-cat-3-chart); }
${P} [data-rp-cat='4'] { --rp-cc-cat-bg: var(--rp-cc-cat-4-bg); --rp-cc-cat-fg: var(--rp-cc-cat-4-text); --rp-cc-cat-line: var(--rp-cc-cat-4-border); --rp-cc-cat-mark: var(--rp-cc-cat-4-chart); }
${P} [data-rp-cat='5'] { --rp-cc-cat-bg: var(--rp-cc-cat-5-bg); --rp-cc-cat-fg: var(--rp-cc-cat-5-text); --rp-cc-cat-line: var(--rp-cc-cat-5-border); --rp-cc-cat-mark: var(--rp-cc-cat-5-chart); }
${P} [data-rp-cat='6'] { --rp-cc-cat-bg: var(--rp-cc-cat-6-bg); --rp-cc-cat-fg: var(--rp-cc-cat-6-text); --rp-cc-cat-line: var(--rp-cc-cat-6-border); --rp-cc-cat-mark: var(--rp-cc-cat-6-chart); }
${P} [data-rp-cat='7'] { --rp-cc-cat-bg: var(--rp-cc-cat-7-bg); --rp-cc-cat-fg: var(--rp-cc-cat-7-text); --rp-cc-cat-line: var(--rp-cc-cat-7-border); --rp-cc-cat-mark: var(--rp-cc-cat-7-chart); }
${P} [data-rp-cat='8'] { --rp-cc-cat-bg: var(--rp-cc-cat-8-bg); --rp-cc-cat-fg: var(--rp-cc-cat-8-text); --rp-cc-cat-line: var(--rp-cc-cat-8-border); --rp-cc-cat-mark: var(--rp-cc-cat-8-chart); }
${P} :is([class*='SectionHeader__container'][data-label], [data-rp-cat]) {
  position: relative;
  background-color: var(--rp-cc-cat-bg, var(--rp-cc-cat-1-bg)) !important;
  color: var(--rp-cc-cat-fg, var(--rp-cc-cat-1-text)) !important;
  box-shadow: inset 0 0 0 1px var(--rp-cc-cat-line, var(--rp-cc-cat-1-border)) !important;
}
${P} :is([class*='SectionHeader__container'][data-label], [data-rp-cat])::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background-color: var(--rp-cc-cat-mark, var(--rp-cc-cat-1-chart));
  pointer-events: none;
}
${P} [class*='SectionHeader__container'][data-label]::after {
  color: var(--rp-cc-cat-fg, var(--rp-cc-cat-1-text)) !important;
  -webkit-text-fill-color: var(--rp-cc-cat-fg, var(--rp-cc-cat-1-text)) !important;
}
/* refined-prun.css 里三套 INV 分类头规则（独立 / FB 普通 / FB 紧凑）带
   5 个属性选择器且用 !important，又挂在 <html> 末尾、文档顺序晚于 <head>
   里的主题样式表。这里再叠三级属性选择器，把底色 / 描边 / 中文文字真正
   压到真实界面上；--rp-cc-cat-* 已由上面的 data-label 规则定义在本元素。 */
${P}[data-rp-theme][data-rp-theme][data-rp-theme] [class*='SectionHeader__container'][data-label] {
  background-color: var(--rp-cc-cat-bg, var(--rp-cc-cat-1-bg)) !important;
  background-image: none !important;
  color: var(--rp-cc-cat-fg, var(--rp-cc-cat-1-text)) !important;
  box-shadow: inset 0 0 0 1px var(--rp-cc-cat-line, var(--rp-cc-cat-1-border)) !important;
}
${P}[data-rp-theme][data-rp-theme][data-rp-theme] [class*='SectionHeader__container'][data-label]::after {
  color: var(--rp-cc-cat-fg, var(--rp-cc-cat-1-text)) !important;
  -webkit-text-fill-color: var(--rp-cc-cat-fg, var(--rp-cc-cat-1-text)) !important;
}

/* ── 图表：图例色块与序列同 token，配合文字标签而非只靠颜色 ─────────── */
${P} :is([class*='Legend__'], [data-rp-chart-series]) :is(span, i, b)::before,
${P} [data-rp-chart-series]::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
  background-color: var(--rp-cc-cat-1-chart);
  border: 1px solid var(--rp-cc-border-default);
  vertical-align: middle;
}
${P} [data-rp-chart-series='1']::before { background-color: var(--rp-cc-cat-1-chart); }
${P} [data-rp-chart-series='2']::before { background-color: var(--rp-cc-cat-2-chart); }
${P} [data-rp-chart-series='3']::before { background-color: var(--rp-cc-cat-3-chart); }
${P} [data-rp-chart-series='4']::before { background-color: var(--rp-cc-cat-4-chart); }
${P} [data-rp-chart-series='5']::before { background-color: var(--rp-cc-cat-5-chart); }
${P} [data-rp-chart-series='6']::before { background-color: var(--rp-cc-cat-6-chart); }
${P} [data-rp-chart-series='7']::before { background-color: var(--rp-cc-cat-7-chart); }
${P} [data-rp-chart-series='8']::before { background-color: var(--rp-cc-cat-8-chart); }
${P} canvas {
  background-color: var(--rp-cc-surface);
  border-radius: 3px;
}

/* ── 图标 / 角标：小面积彩色，不做每卡片随机底色 ────────────────────── */
${P} [class*='MaterialIcon__indicator'] {
  color: var(--rp-cc-cat-4-text) !important;
  background-color: var(--rp-cc-cat-4-bg) !important;
}
${P} [class*='ColoredIcon__container'] {
  background: linear-gradient(135deg, var(--rp-cc-surface), var(--rp-cc-cat-1-bg)) !important;
  border: 1px solid var(--rp-cc-border-default) !important;
  color: var(--rp-cc-text-primary) !important;
}

/* ── 装饰线 / 分隔：单一分类蓝，不用随机渐变 ──────────────────────────
   必须排除 TileDivider__*：那是游戏屏幕布局里「可左右拖动调整列宽」的
   分隔条（cursor: col-resize，9px 宽、贯穿全屏高）。原生是透明/极淡，
   只给纯装饰性的 Divider / hr 上色；否则它会被染成一条显眼的实色竖条。 */
${P} :is([class*='Divider__']:not([class*='TileDivider__']), hr) {
  border-color: var(--rp-cc-border-subtle) !important;
  background-color: var(--rp-cc-border-subtle) !important;
}
${P} [class*='ContextControls__item'] {
  border-color: var(--rp-cc-border-default) !important;
  color: var(--rp-cc-text-primary) !important;
}
${P} [class*='ContextControls__item']:hover {
  background-color: var(--rp-cc-btn-secondary-hover) !important;
}

/* ── 移动端：触控目标与输入框高度，焦点环保持可见 ───────────────────── */
@media (max-width: 700px) {
  ${P} :is(button, [class*='Button__btn']) {
    min-height: 32px;
  }
  ${P} :is(input, select, textarea) {
    min-height: 34px;
    font-size: 14px;
  }
  /* :is() 里保留 [tabindex]，与主焦点规则特异性完全一致；同为 !important
     时由后面这条媒体查询胜出，把移动端焦点环加粗到 3px。 */
  ${P} :is(button, a, input, select, textarea, [tabindex]):focus-visible {
    outline-width: 3px !important;
  }
}
`;
}

/** 按主题 id 生成组件类型 → token 的映射规则；颜色只来自 --rp-cc-* 色板。 */
export function buildComponentCss(themeId: string = CERAMIC_THEME_ID): string {
  return componentCssFor(themeId);
}
