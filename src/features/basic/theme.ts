import { watchEffect } from 'vue';
import { userData } from '@src/store/user-data';
import { applyThemeAppearance } from './theme-appearance';
import { buildCeramicSkin, buildComponentCss } from './theme-ceramic';
import { CUSTOM_THEME_ID_SET, DEFAULT_THEME_ID, THEMES } from './theme-registry';

// 界面主题：不再使用 html 上的 invert/hue-rotate 滤镜，而是直接改写颜色。
// 扫描页面样式表，把每条声明里的颜色按「角色」重映射到一套低饱和浅色皮肤：
//   · 中性色 / 低饱和深色（含游戏原本的深蓝灰面板、深棕输入框）→ 浅底深字；
//   · 鲜艳彩色 → 收敛成「石板蓝 / muted 红 / muted 绿」三类，文字用深色、背景用淡色；
//   · 运行时 inline style 上色的物料图标、表单控件、按钮，用 CONTROL_CSS 兜底。
// 每套皮肤只换一组色彩 token，图片 / canvas / 数据本身完全不受影响。

const STYLE_ID = 'rprun-theme';
const COLOR_RE =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

type RGBA = [number, number, number, number];
type Role = 'text' | 'background' | 'border' | 'gradient' | 'other';
type Bucket = Map<string, Map<string, string>>;
type Family = 'slate' | 'red' | 'green';

interface FamilyColors {
  text: string;
  background: string;
  gradient: [string, string];
  border: string;
}

interface StatusColors {
  background: string;
  text: string;
  border: string;
}

// 可选的 8 色相带调色板：只对「陶瓷白多彩」主题启用。启用后，原本鲜艳的
// 游戏彩色按色相映射到固定色带（同一色相全站同色），light / paper 仍然走
// 下面的三族收敛，行为完全不变。
export interface Skin {
  vars: Record<string, string>;
  palette: Record<Family, FamilyColors>;
  hueBands?: Record<string, FamilyColors>;
  // 加在中性灰上的轻微 RGB 偏移，让整套皮肤带一点冷/暖倾向。
  neutralShift: [number, number, number];
  // 深色主题标记：中性色文字的映射方向。浅色主题要把游戏/插件遗留的浅灰文字
  // 反成深色（否则浅底上看不清）；深色主题必须相反——中性文字一律映射为浅色，
  // 否则 #C8D0D6 这类文字会被反成 #292823 压在深底上完全不可读。token 模式取
  // 注册表的 dark 标记（theme-registry.ts），未设置时按浅色主题处理。
  darkText?: boolean;
  // 期限/告警语义色：这类底色承载「还剩几天 / 该修了」的信息，不能和装饰性
  // 橙黄一起收敛成石板蓝。用低饱和的柔和黄/红 + 深色字 + 左侧细色条，
  // 既能在浅底上一眼分辨，又不会把界面重新铺满彩色。
  status: { warning: StatusColors; danger: StatusColors };
  // 选中态指示器（RadioItem 竖条、Tabs/HeadItem 下划线、Frame/Dock 侧边小色块）：
  // 游戏原生是「未选中 = 同色低透明、选中 = 实色高对比」，通用降饱和会把实色
  // 压成≈背景的淡色，选中与未选中就分不出。这里把选中态拉回深色。
  indicator: {
    active: string;
    idle: string;
    success: string;
    danger: string;
    glow: string;
    line: string;
    lineSoft: string;
  };
  // 游戏原生「呼吸灯」的三档配色：与 indicator / status 完全独立，每套主题各自
  // 定义，让通知脉冲跟该主题的主色调一致，而不是借通用的成功/警告色。
  pulse: {
    success: string;
    secondary: string;
    danger: string;
  };
  // <progress> 容量条：填充按 primary/secondary/warning 分色，轨道明显更浅并补
  // 一圈边框，避免「已用 / 剩余」被统一映射成同一个淡色后完全看不出比例。
  progress: {
    primary: string;
    secondary: string;
    warning: string;
    success: string;
    danger: string;
    track: string;
    border: string;
  };
}

// 自定义主题（注册表里 mode 非 native 的项）都会注入覆盖表；色板一律由
// buildCeramicSkin() 从 CSS token 组装，不再有第二份 TS 侧色板。

// 控件规则两套皮肤共用，颜色全部走 --rp-skin-* 变量。
// 这些规则专门对付「样式表里没有的颜色」：运行时 inline style、浏览器默认控件，
// 以及需要额外补边框/字重才能分出层级的按钮。
const CONTROL_CSS = `
html[data-rp-theme] body {
  background-color: var(--rp-skin-bg) !important;
  background-image: var(--rp-skin-bg-image, none) !important;
}
/* 游戏原生窗口外壳是 repeating-linear-gradient 深色斜纹底（新建 / 点按钮
   弹出的缓存窗口都用这个壳）。主题引擎只把里面的颜色重映射成浅灰，斜纹
   本身还在，三个自定义主题下就变成明显的灰色斑马纹窗体背景 / 边缘条纹。
   这里统一清掉背景图，只留皮肤的纯色底；重复 [data-rp-theme] 提高特异性，
   压过重映射表里带 !important 的同类规则。 */
html[data-rp-theme][data-rp-theme] [class*="Window__window"] {
  background-image: none !important;
}
html[data-rp-theme] [class*="Button__btn"] {
  color: var(--rp-skin-ink) !important;
  background-color: var(--rp-skin-panel) !important;
  background-image: none !important;
  border: 1px solid var(--rp-skin-border) !important;
  border-radius: 2px;
  box-sizing: border-box;
  text-shadow: none !important;
}
html[data-rp-theme] [class*="Button__btn"]:hover {
  border-color: var(--rp-skin-border-strong) !important;
  background-color: var(--rp-skin-hover) !important;
}
html[data-rp-theme] [class*="Button__btn"][class*="Button__primary"] {
  color: var(--rp-skin-ink) !important;
  background-color: var(--rp-skin-panel-strong) !important;
  border-color: var(--rp-skin-border-strong) !important;
  font-weight: 600;
}
html[data-rp-theme] [class*="Button__btn"][class*="Button__disabled"],
html[data-rp-theme] button:disabled {
  color: var(--rp-skin-disabled) !important;
  background-color: var(--rp-skin-disabled-bg) !important;
  border-color: var(--rp-skin-disabled-border) !important;
  opacity: 1 !important;
}
/* CXPO 买入（success）与卖出（danger）按钮：在自定义主题下也要保留绿/红语义，
   但深度降到原主题的约 1/3（浅底 + 深语义字），避免与原游戏深色按钮一样重。
   hover 仅加深边框、保持浅底；active 用边框色作按压反馈（R32）。 */
html[data-rp-theme] [class*="Button__btn"][class*="Button__success"] {
  color: var(--rp-skin-success) !important;
  background-color: var(--rp-skin-success-bg) !important;
  border-color: var(--rp-skin-success-border) !important;
}
html[data-rp-theme] [class*="Button__btn"][class*="Button__success"]:hover {
  color: var(--rp-skin-success) !important;
  background-color: var(--rp-skin-success-bg) !important;
  border-color: var(--rp-skin-success) !important;
}
html[data-rp-theme] [class*="Button__btn"][class*="Button__success"]:active {
  background-color: var(--rp-skin-success-border) !important;
}
html[data-rp-theme] [class*="Button__btn"][class*="Button__danger"] {
  color: var(--rp-skin-danger) !important;
  background-color: var(--rp-skin-danger-bg) !important;
  border-color: var(--rp-skin-danger-border) !important;
}
html[data-rp-theme] [class*="Button__btn"][class*="Button__danger"]:hover {
  color: var(--rp-skin-danger) !important;
  background-color: var(--rp-skin-danger-bg) !important;
  border-color: var(--rp-skin-danger) !important;
}
html[data-rp-theme] [class*="Button__btn"][class*="Button__danger"]:active {
  background-color: var(--rp-skin-danger-border) !important;
}
html[data-rp-theme] input,
html[data-rp-theme] select,
html[data-rp-theme] textarea,
html[data-rp-theme] option {
  color: var(--rp-skin-ink) !important;
  background-color: var(--rp-skin-input-bg) !important;
  border: 1px solid var(--rp-skin-border) !important;
  border-radius: 2px;
  box-sizing: border-box;
  text-shadow: none !important;
}
html[data-rp-theme] input[type="checkbox"],
html[data-rp-theme] input[type="radio"] {
  accent-color: var(--rp-skin-selection);
}
html[data-rp-theme] [class*="FormComponent__containerActive"],
html[data-rp-theme] [class*="forms__active"] {
  background-color: var(--rp-skin-active-bg) !important;
}
html[data-rp-theme] [class*="ColoredIcon__container"],
html[data-rp-theme] [class*="BuildingIcon__container"] {
  background: linear-gradient(135deg, var(--rp-skin-icon-a), var(--rp-skin-icon-b)) !important;
  color: var(--rp-skin-ink) !important;
  border: 1px solid var(--rp-skin-icon-border) !important;
  text-shadow: none !important;
}
html[data-rp-theme] [class*="ColoredIcon__label"],
html[data-rp-theme] [class*="ColoredIcon__labelContainer"],
html[data-rp-theme] [class*="BuildingIcon__ticker"],
html[data-rp-theme] [class*="BuildingIcon__tickerContainer"] {
  color: var(--rp-skin-ink) !important;
  text-shadow: none !important;
}
html[data-rp-theme] [class*="MaterialIcon__indicator"] {
  color: var(--rp-skin-ink) !important;
  background-color: var(--rp-skin-indicator-bg) !important;
  /* 数量角标不描边：物料 / 建筑图标自身已有一圈边框，角标再加一圈会形成
     内外双框。数字靠深墨字 + 浅实底保证可读，不需要额外轮廓。 */
  border: 0 !important;
  outline: 0 !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
/* BRA「所需材料」：游戏用 MaterialIcon__danger 标出仓库不够的数量，但上面那条
   统一角标色把它的红压成了墨色，缺料看不出来。这里只在 BRA 面板把 danger 角标的
   文字色恢复成语义红，其它面板的角标保持原样（见 R27）。 */
html[data-rp-theme][data-rp-theme] [class*='rp-command-BRA'] [class*='MaterialIcon__indicator'][class*='MaterialIcon__danger'] {
  color: var(--rp-skin-danger) !important;
}
html[data-rp-theme] [class*="RadioItem__value"],
html[data-rp-theme] [class*="Checkbox__label"],
html[data-rp-theme] [class*="Toggle__label"] {
  color: var(--rp-skin-muted) !important;
}
/* FLT / FLEET 货物条的轨道：组件已改成纯色，这里用皮肤的中浅纯色 + 细边框，
   避免原先 repeating-linear-gradient 里 inline 的深灰变量残留成黑白斜纹。 */
html[data-rp-theme] .rp-cargo-track {
  background-color: var(--rp-skin-panel-strong) !important;
  background-image: none !important;
  border: 1px solid var(--rp-skin-border) !important;
  box-sizing: border-box;
}
/* 底部状态栏：资金 / 版本号 / 在线人数。游戏原生是白字，版本号还是
   -webkit-text-fill-color: transparent + background-clip: text 的渐变字，
   主题把渐变换成浅色后字直接糊在浅底上；这里统一给回深墨实色字。 */
html[data-rp-theme] [class*="HeadItem__container"],
html[data-rp-theme] [class*="HeadItem__label"],
html[data-rp-theme] [class*="HeadItem__link"],
html[data-rp-theme] [class*="UsersOnlineCount__container"] {
  color: var(--rp-skin-ink) !important;
  -webkit-text-fill-color: var(--rp-skin-ink) !important;
  font-weight: 600;
}
html[data-rp-theme] [class*="UsersOnlineCount__container"] {
  background-color: var(--rp-skin-panel) !important;
  border-top-color: var(--rp-skin-border) !important;
}
html[data-rp-theme] [class*="rprun-version-label__label"] {
  background-image: none !important;
  -webkit-background-clip: border-box !important;
  background-clip: border-box !important;
}
/* XIT FLT / ETA 列与 SHPI 标题栏图标按钮：按主题统一成「Button primary」
   式样（浅实底 + 细边框 + 2px 圆角 + 深墨图标），对齐 FLEET 未分配船只按钮；
   不再用橙 / 绿 / 红三块彩色实底区分，功能交给 ⭳ / ✈ / 油泵图案本身。
   倒计时是组件写死的淡蓝 / 灰 inline 色，单独覆盖成深墨保证浅底可读。 */
html[data-rp-theme] [class*="TimeCell__timeColumn"] > span:first-child {
  color: var(--rp-skin-eta, #1f5f8f) !important;
  font-weight: 600;
  opacity: 1 !important;
}
html[data-rp-theme] [class*="TimeCell__timeColumn"] > span:last-child {
  color: var(--rp-skin-eta-sub, #4a5863) !important;
  opacity: 1 !important;
}
html[data-rp-theme] [class*="TimeCell__actionBtn"],
html[data-rp-theme] [data-rp-shpi-action] {
  color: var(--rp-skin-ink) !important;
  -webkit-text-fill-color: var(--rp-skin-ink) !important;
  background-color: var(--rp-skin-panel-strong) !important;
  background-image: none !important;
  border: 1px solid var(--rp-skin-border-strong) !important;
  border-radius: 2px !important;
  box-sizing: border-box;
  font-weight: 600;
  text-shadow: none !important;
}
html[data-rp-theme] [class*="TimeCell__actionBtn"]:hover,
html[data-rp-theme] [data-rp-shpi-action]:hover {
  background-color: var(--rp-skin-hover) !important;
  border-color: var(--rp-skin-selection) !important;
}
/* 组件 / SHPI 模块写死的橙绿红底色统一压回主题按钮底色 */
html[data-rp-theme] [class*="TimeCell__bgOrange"],
html[data-rp-theme] [class*="TimeCell__bgGreen"],
html[data-rp-theme] [class*="TimeCell__bgFuel"],
html[data-rp-theme] [data-rp-shpi-action="unload"],
html[data-rp-theme] [data-rp-shpi-action="flight"] {
  background-color: var(--rp-skin-panel-strong) !important;
}
html[data-rp-theme] [class*="TimeCell__iconSvg"] {
  color: var(--rp-skin-ink) !important;
  fill: currentColor !important;
}
/* SFC 顶部「燃料 1,500/1,500 / 2,000/2,000」的两个 30×9px 容量条：
   R33 为给 XIT FLT 的大号燃料条减重，把 <progress> 主/次填充统一减半成浅色，
   小条在浅轨道上几乎看不出填充与剩余。这里只在 ShipFuel 作用域恢复全深度
   填充，并把轨道换成主题底色、边框换成 border-strong；FLT 大条与图表序列色
   保持 R33 现状不变。三档 html[data-rp-theme] 抬特异性，压过引擎 CSSOM 生成的
   ::-webkit-progress-value 覆盖与陶瓷白 buildComponentCss 的进度条规则（R06）。
   颜色一律走色板变量，不在组件规则写裸色值（R01）；原样主题无前缀不生效（R21）。 */
html[data-rp-theme][data-rp-theme][data-rp-theme] [class*="ShipFuel__container"] [class*="ProgressBar__progress"] {
  background-color: var(--rp-skin-bg, transparent) !important;
  border: 1px solid var(--rp-skin-border-strong, currentColor) !important;
}
html[data-rp-theme][data-rp-theme][data-rp-theme] [class*="ShipFuel__container"] [class*="ProgressBar__progress"]::-webkit-progress-bar {
  background-color: var(--rp-skin-bg, transparent) !important;
}
html[data-rp-theme][data-rp-theme][data-rp-theme] [class*="ShipFuel__container"] [class*="ProgressBar__primary"]::-webkit-progress-value {
  background-color: var(--rp-skin-sfc-fuel-stl, var(--rp-skin-ink, currentColor)) !important;
}
html[data-rp-theme][data-rp-theme][data-rp-theme] [class*="ShipFuel__container"] [class*="ProgressBar__secondary"]::-webkit-progress-value {
  background-color: var(--rp-skin-sfc-fuel-ftl, var(--rp-skin-ink, currentColor)) !important;
}
html[data-rp-theme] * { scrollbar-color: var(--rp-skin-scroll-thumb) var(--rp-skin-bg); }
`;

function tokensFor(theme: string, skin: Skin): string {
  const decls = Object.entries(skin.vars)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
  return `
html[data-rp-theme='${theme}'] {
  color-scheme: light;
${decls}
}
html[data-rp-theme='${theme}'] ::selection {
  background: var(--rp-skin-selection);
  color: var(--rp-skin-on-accent, #fff);
}
`;
}

function parseColor(token: string): RGBA | null {
  if (token.startsWith('#')) {
    let hex = token.slice(1);
    if (hex.length <= 4) {
      hex = [...hex].map(c => c + c).join('');
    }
    if (hex.length < 6) {
      return null;
    }
    const alpha = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      alpha,
    ];
  }
  const nums = (token.match(/[\d.]+/g) ?? []).map(Number);
  if (/^hsl/i.test(token)) {
    const [h, s, l, a = 1] = nums;
    const c = (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l / 100 - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) {
      r = c;
      g = x;
    } else if (h < 120) {
      r = x;
      g = c;
    } else if (h < 180) {
      g = c;
      b = x;
    } else if (h < 240) {
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      b = c;
    } else {
      r = c;
      b = x;
    }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), a];
  }
  if (nums.length < 3) {
    return null;
  }
  return [nums[0], nums[1], nums[2], nums[3] ?? 1];
}

// 用绝对色差判定中性：游戏主色是 rgb(26,33,38) 这类深蓝灰（相对饱和 0.32），
// 旧版用「相对饱和度 <= 0.30」会把它当语义色保留，结果浅色底上残留大片深色面板。
function isNeutral([r, g, b]: RGBA): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) <= 42;
}

function hueOf([r, g, b]: RGBA): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) {
    return 0;
  }
  let h: number;
  if (max === r) {
    h = ((g - b) / d) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function familyOf(rgba: RGBA): Family {
  const hue = hueOf(rgba);
  if (hue < 18 || hue >= 335) {
    return 'red';
  }
  if (hue >= 75 && hue < 175) {
    return 'green';
  }
  return 'slate';
}

// 多彩主题专用：把色相切成 8 个固定色带，key 与 theme-ceramic.ts 的
// ceramicHueBands() 一一对应。相同的输入色相永远得到相同的分类色，
// 因此「同一分类全站同色」，不会变成每卡片随机配色。
function bandKeyOf(rgba: RGBA): string {
  const h = hueOf(rgba);
  if (h < 22 || h >= 330) {
    return 'rose';
  }
  if (h < 55) {
    return 'amber';
  }
  if (h < 90) {
    return 'olive';
  }
  if (h < 160) {
    return 'teal';
  }
  if (h < 200) {
    return 'cyan';
  }
  if (h < 250) {
    return 'blue';
  }
  if (h < 290) {
    return 'violet';
  }
  return 'plum';
}

function roleOf(prop: string, value: string): Role {
  if (
    /^(color|fill|stroke|caret-color|text-decoration-color|-webkit-text-fill-color)$/.test(prop)
  ) {
    return 'text';
  }
  if (
    prop === 'background-image' ||
    (prop.startsWith('background') && value.includes('gradient('))
  ) {
    return 'gradient';
  }
  if (prop.startsWith('background')) {
    return 'background';
  }
  if (
    /color$/.test(prop) ||
    prop === 'box-shadow' ||
    prop === 'text-shadow' ||
    prop === 'outline'
  ) {
    return 'border';
  }
  return 'other';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mapColor(token: string, role: Role, index: number, skin: Skin): string {
  const rgba = parseColor(token);
  if (!rgba) {
    return token;
  }
  const [r, g, b, a] = rgba;
  const withAlpha = (color: string): string => {
    if (a >= 1) {
      return color;
    }
    const parsed = parseColor(color);
    return parsed ? `rgba(${parsed[0]}, ${parsed[1]}, ${parsed[2]}, ${a})` : color;
  };

  if (isNeutral(rgba)) {
    const v = (r + g + b) / 3;
    let out: number;
    if (skin.darkText) {
      // 深色主题：把中性色的亮度方向整体翻转——文字→浅、背景→深、边线→中灰。
      // 这等价于把「浅色游戏界面」反成「深色界面」，插件里 #111111 这类深底
      // 不会被翻成浅底、#C8D0D6 这类浅字也不会被翻成深字，从而全站可读。
      switch (role) {
        case 'text':
          out = 205;
          break;
        case 'background':
          out = 14 + v * 0.11;
          break;
        case 'border':
          out = 45 + v * 0.28;
          break;
        case 'gradient':
          out = 14 + v * 0.11 - (index % 2) * 5;
          break;
        default:
          out = 45 + v * 0.28;
          break;
      }
    } else {
      // 浅色主题（ceramic 等）：维持原有反转逻辑，行为完全不变。
      switch (role) {
        case 'text':
          out = v < 40 ? 30 : (255 - v) * 0.82;
          break;
        case 'background':
          out = 252 - v * 0.3;
          break;
        case 'border':
          out = 236 - v * 0.45;
          break;
        case 'gradient':
          out = 246 - v * 0.34 - (index % 2) * 8;
          break;
        default:
          out = 236 - v * 0.4;
          break;
      }
    }
    const gray = clamp(out);
    const [sr, sg, sb] = skin.neutralShift;
    const cr = clamp(gray + sr);
    const cg = clamp(gray + sg);
    const cb = clamp(gray + sb);
    return a < 1 ? `rgba(${cr}, ${cg}, ${cb}, ${a})` : `rgb(${cr}, ${cg}, ${cb})`;
  }

  const palette = skin.hueBands?.[bandKeyOf(rgba)] ?? skin.palette[familyOf(rgba)];
  let color: string;
  switch (role) {
    case 'text':
      color = palette.text;
      break;
    case 'gradient':
      color = palette.gradient[index % 2];
      break;
    case 'border':
      color = palette.border;
      break;
    default:
      color = palette.background;
      break;
  }
  return withAlpha(color);
}

function mapValue(value: string, prop: string, skin: Skin): string | undefined {
  if (!value.match(COLOR_RE)) {
    return undefined;
  }
  const role = roleOf(prop, value);
  let index = 0;
  const mapped = value.replace(COLOR_RE, token => mapColor(token, role, index++, skin));
  return mapped === value ? undefined : mapped;
}

function hasSemanticBackground(style: CSSStyleDeclaration): boolean {
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (!prop.includes('background')) {
      continue;
    }
    const tokens = style.getPropertyValue(prop).match(COLOR_RE);
    if (
      tokens?.some(t => {
        const parsed = parseColor(t);
        return parsed !== null && !isNeutral(parsed);
      })
    ) {
      return true;
    }
  }
  return false;
}

function addToBucket(bucket: Bucket, selector: string, decls: Map<string, string>) {
  if (decls.size === 0) {
    return;
  }
  const existing = bucket.get(selector) ?? new Map<string, string>();
  for (const [prop, value] of decls) {
    existing.set(prop, value);
  }
  bucket.set(selector, existing);
}

// 游戏用 Workforces__daysWarning / daysMissing 给「剩余天数、维修期限、仓储告警」
// 上色。通用映射会把琥珀黄归到石板蓝族、又保留 0.3 的 alpha，浅底上几乎看不见。
// 这两类语义状态直接给一套柔和底色 + 深字：信息一眼可辨，且只靠底色强调，
// 不再叠加左侧色条。daysSupplied（正常绿）继续走通用映射保持素淡。
const STATUS_RE = /days(Warning|Missing)/;

// 游戏原生「呼吸灯」：左侧竖排按钮 COM 右缘的新消息脉冲、COM 面板内频道左缘的
// 未读竖条，共用 effects__shadowPulse{Success,Secondary,Failure}——有色小块 + 6px
// 同色外发光 + 2s 无限 opacity 呼吸。它们承载通知语义，通用降饱和会把亮绿/亮蓝/
// 亮红压成 ≈ 画布的淡色（浅色主题下几乎看不见）。这里改走每套主题自己的
// skin.pulse 三档配色，与主题主色调一致；animation 保持原样不动。
const PULSE_RE = /effects__shadowPulse(Success|Secondary|Failure)/;

function pulseOverride(selector: string, skin: Skin): Map<string, string> | null {
  const match = selector.match(PULSE_RE);
  if (!match) {
    return null;
  }
  const color =
    match[1] === 'Success'
      ? skin.pulse.success
      : match[1] === 'Failure'
        ? skin.pulse.danger
        : skin.pulse.secondary;
  return new Map<string, string>([
    ['background-color', color],
    // 原生是 6px 无扩散；浅底上把光晕略微加宽，呼吸时才看得出「发光」而不是
    // 一条普通细线。颜色仍与色块同色，避免引入第二套色值。
    ['box-shadow', `0 0 8px 1px ${color}`],
  ]);
}

function statusOverride(selector: string, skin: Skin): Map<string, string> | null {
  const match = selector.match(STATUS_RE);
  if (!match) {
    return null;
  }
  const status = match[1] === 'Warning' ? skin.status.warning : skin.status.danger;
  return new Map<string, string>([
    ['background-color', status.background],
    ['color', status.text],
    // 不在色块前面加左侧彩色竖线：黄 / 红底色本身就是强调，再加一条 2px
    // inset 色条会显得多余。显式清空，压掉游戏原生可能带的内阴影。
    ['box-shadow', 'none'],
  ]);
}

// 状态圆点：游戏原生是「实色圆点 + 同色柔光」，用来标记航线节点、任务步骤等
// 是否正常 / 告警 / 异常。通用降饱和会把它压成 ≈ 背景的透明淡色，浅底深底都
// 几乎看不见，必须单独给回实色。必须用 `\.Status__` 锚定：OrderStatus__* /
// ContractStatus__* / AdStatus__* 是其它语义状态徽章，Status__light 只是圆点
// 底座（无底色），都不参与。
const STATUS_DOT_RE = /\.Status__(ok|warning|error)/;

function statusDotOverride(selector: string, skin: Skin): Map<string, string> | null {
  const match = selector.match(STATUS_DOT_RE);
  if (match === null) {
    return null;
  }
  // 取各皮肤都提供的实色：绿 / 暗琥珀 / 红。warning 用深琥珀字色而不是
  // status.warning.border——后者在浅底上只有约 1.8:1，圆点依旧看不清。
  const color =
    match[1] === 'ok'
      ? skin.indicator.success
      : match[1] === 'warning'
        ? skin.status.warning.text
        : skin.indicator.danger;
  return new Map<string, string>([
    ['background-color', color],
    ['box-shadow', `0 0 5px 1px ${color}`],
  ]);
}

// ── 选中态指示器 / 进度条：语义色覆盖 ────────────────────────────────────
// 游戏与插件大量用「小色块」表示选中：RadioItem 的竖条、Tabs / HeadItem 的下划线、
// Frame / Dock / Alert 的侧边指示；另外还有 <progress> 容量条（STL/FTL 燃料等）。
// 原生做法一律是「未选中 = 同色低透明、选中 = 实色高对比」「已用 = 彩色、剩余 =
// 深色轨道」，而通用降饱和会把所有实色收成≈背景的淡色，于是选中/未选中、已用/
// 剩余全都分不出。这里按组件类名单独给回对比度，其余装饰色仍走低饱和映射。
const INDICATOR_BLOCK_RE =
  /(?:RadioItem__|Tabs__toggleIndicator|HeadItem__indicator|Frame__toggleIndicator|Indicator__|ChannelMembershipListitem__indicator|AlertListItem__indicator|Dock__indicator|TaskListItem__indicator|GridItemView__selected|Steps__active|suggestionHighlighted|__active___)/;
const INDICATOR_ACTIVE_RE =
  /(?:Active|active|Enabled|enabled|Unread|Incomplete|Blocked|Opened|Highlighted|highlighted)/;
const INDICATOR_LINE_RE =
  /(?:Selections__selection|GridItemView__selected|TemplateSelection__group|:focus\b|rc-slider-dot-active)/;
const PROGRESS_RE =
  /(?:ProgressBar__|FactorBar__|RangeBar__|progressFill|progressBar|progressTrack|::-webkit-progress|::-moz-progress)/i;
const BORDER_COLOR_RE = /^border-(?:top|right|bottom|left)-color$/;
const BACKGROUND_PROP_RE = /^background(?:-color)?$/;

function semanticOverride(
  selector: string,
  style: CSSStyleDeclaration,
  skin: Skin,
): Map<string, string> | null {
  const out = new Map<string, string>();

  // 1) <progress> 容量条：填充分色（primary / secondary / warning / green / red），
  //    轨道给明显更浅的纯色并补边框，让「已用 / 剩余」的比例一眼可辨。
  if (PROGRESS_RE.test(selector)) {
    if (/::-webkit-progress-value|::-moz-progress-bar/.test(selector)) {
      let fill = skin.progress.primary;
      if (/secondary/i.test(selector)) {
        fill = skin.progress.secondary;
      } else if (/warning/i.test(selector)) {
        fill = skin.progress.warning;
      } else if (/green/i.test(selector)) {
        fill = skin.progress.success;
      } else if (/red/i.test(selector)) {
        fill = skin.progress.danger;
      }
      for (let i = 0; i < style.length; i++) {
        if (BACKGROUND_PROP_RE.test(style[i])) {
          out.set(style[i], fill);
        }
      }
    } else if (/progressFill/i.test(selector)) {
      for (let i = 0; i < style.length; i++) {
        if (BACKGROUND_PROP_RE.test(style[i])) {
          out.set(style[i], skin.progress.primary);
        }
      }
    } else if (
      /::-webkit-progress-bar|__progress___|progressBar|progressTrack|__progressTrack___/i.test(
        selector,
      )
    ) {
      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        if (BACKGROUND_PROP_RE.test(prop)) {
          out.set(prop, skin.progress.track);
        } else if (BORDER_COLOR_RE.test(prop)) {
          out.set(prop, skin.progress.border);
        }
      }
    }
    return out.size > 0 ? out : null;
  }

  // 2) 色块型选中指示器。只处理「原本就是彩色小色块」的规则：像 forms__active
  //    这类中性深灰容器不加深，否则会变成深底深字反而看不清。
  if (INDICATOR_BLOCK_RE.test(selector)) {
    let hasColoredBg = false;
    for (let i = 0; i < style.length; i++) {
      if (!BACKGROUND_PROP_RE.test(style[i])) {
        continue;
      }
      const token = style.getPropertyValue(style[i]).match(COLOR_RE)?.[0];
      const parsed = token ? parseColor(token) : null;
      if (parsed && !isNeutral(parsed)) {
        hasColoredBg = true;
      }
    }
    if (hasColoredBg) {
      const active = INDICATOR_ACTIVE_RE.test(selector);
      const color = !active
        ? skin.indicator.idle
        : /Failure|Error|Danger/i.test(selector)
          ? skin.indicator.danger
          : /Success|Pulse/i.test(selector)
            ? skin.indicator.success
            : skin.indicator.active;
      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        if (BACKGROUND_PROP_RE.test(prop)) {
          out.set(prop, color);
        } else if (active && prop === 'box-shadow') {
          out.set(prop, `0 0 6px 0 ${skin.indicator.glow}`);
        }
      }
      // 选中块若带文字（如 forms__active 的 label），字要反色，否则会被上面
      // 「彩色块统一深字」的规则压成深底深字。反色字取主题的 on-accent 墨：
      // token 深色主题它是深底字（实色块是霓虹亮色），浅色主题与 skin 主题
      // 走回退的白色，与原先一致。
      if (active) {
        out.set('color', 'var(--rp-skin-on-accent, #ffffff)');
      }
    }
  }

  // 3) 下划线 / 焦点线 / 选中块边框：把 border-*-color 拉回深色。
  if (INDICATOR_LINE_RE.test(selector)) {
    const line = /GridItemView__selected/.test(selector)
      ? skin.indicator.lineSoft
      : skin.indicator.line;
    for (let i = 0; i < style.length; i++) {
      if (BORDER_COLOR_RE.test(style[i])) {
        out.set(style[i], line);
      }
    }
  }

  return out.size > 0 ? out : null;
}

// 主题自己的 token 定义块（src/features/basic/themes/<id>.css 里的
// html[data-rp-theme='<id>'] { ... }，构建时合并进 dist/refined-prun.css）
// 存的是皮肤色值本身，不能被当成「游戏原生颜色」重新映射，否则整张色板会被压成中性灰。
// 只跳过精确的 token 规则，组件映射规则照常参与扫描。
const TOKEN_RULE_RE = /^html\[data-rp-theme=[^\]]+\](?:\s+body)?$/;

// 遍历所有同源样式表。@media / @supports 内的规则按其原始前缀单独归档，
// 保证覆盖规则和原规则处在相同的媒体条件下。
function collect(
  rules: CSSRuleList,
  plain: Bucket,
  grouped: Map<string, Bucket>,
  skin: Skin,
  prefix?: string,
) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as CSSStyleRule & CSSGroupingRule;
    if (typeof rule.selectorText === 'string' && !TOKEN_RULE_RE.test(rule.selectorText)) {
      const bucket = prefix ? (grouped.get(prefix) ?? new Map()) : plain;
      if (prefix) {
        grouped.set(prefix, bucket);
      }
      // 呼吸灯优先：它既是语义通知，又完全靠 box-shadow 发光，被通用映射压淡后
      // 等于没有提示。其次是期限/告警语义色，同样不能被降饱和吃掉。
      const pulse = pulseOverride(rule.selectorText, skin);
      const status = pulse === null ? statusOverride(rule.selectorText, skin) : null;
      const override = pulse ?? status;
      if (override !== null) {
        addToBucket(bucket, rule.selectorText, override);
      } else {
        // 彩色块在浅色皮肤里会变成淡底，文字必须统一成深色才看得清。
        const coloredBg = hasSemanticBackground(rule.style);
        const decls = new Map<string, string>();
        for (let j = 0; j < rule.style.length; j++) {
          const prop = rule.style[j];
          if (coloredBg && (prop === 'color' || prop === 'fill' || prop === 'stroke')) {
            continue;
          }
          const mapped = mapValue(rule.style.getPropertyValue(prop), prop, skin);
          if (mapped !== undefined) {
            decls.set(prop, mapped);
          }
        }
        if (coloredBg) {
          decls.set('color', skin.vars['--rp-skin-ink'] ?? '#26333d');
        }
        // 选中指示器 / 进度条单独给回对比度，覆盖上面的通用降饱和结果。
        const semantic = semanticOverride(rule.selectorText, rule.style, skin);
        if (semantic) {
          for (const [prop, value] of semantic) {
            decls.set(prop, value);
          }
        }
        // 状态圆点最后兜底：它原本是实色 + 同色柔光，上面两步都不会给它实色，
        // 不补回来就会留成 ≈ 背景的透明淡色。
        const statusDot = statusDotOverride(rule.selectorText, skin);
        if (statusDot) {
          for (const [prop, value] of statusDot) {
            decls.set(prop, value);
          }
        }
        addToBucket(bucket, rule.selectorText, decls);
      }
    }
    const children = rule.cssRules as CSSRuleList | undefined;
    if (children === undefined || children.length === 0) {
      continue;
    }
    const brace = rule.cssText.indexOf('{');
    const atPrefix = brace > 0 ? rule.cssText.slice(0, brace).trim() : '';
    collect(children, plain, grouped, skin, atPrefix.startsWith('@') ? atPrefix : prefix);
  }
}

function renderBucket(bucket: Bucket): string {
  const blocks: string[] = [];
  for (const [selector, decls] of bucket) {
    const body = [...decls].map(([prop, value]) => `${prop}: ${value} !important`).join('; ');
    blocks.push(`${selector} { ${body} }`);
  }
  return blocks.join('\n');
}

function buildCss(skin: Skin): string {
  const plain: Bucket = new Map();
  const grouped = new Map<string, Bucket>();
  for (const sheet of document.styleSheets) {
    // 必须跳过自己：否则上一次生成的覆盖色会被再次反转，反复切换会累积失真。
    if (sheet.ownerNode instanceof HTMLStyleElement && sheet.ownerNode.id === STYLE_ID) {
      continue;
    }
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // 跨域样式表读不到 cssRules，跳过（游戏自身的样式表是同源的）。
      continue;
    }
    collect(rules, plain, grouped, skin);
  }
  let css = renderBucket(plain);
  for (const [prefix, bucket] of grouped) {
    css += `\n${prefix} { ${renderBucket(bucket)} }`;
  }
  return css;
}

function init() {
  watchEffect(() => applyThemeAppearance(document.documentElement, userData.settings));

  const style = document.createElement('style');
  style.id = STYLE_ID;
  document.head.appendChild(style);

  let observer: MutationObserver | undefined;
  let timer: number | undefined;

  const apply = () => {
    const theme = userData.settings.theme ?? DEFAULT_THEME_ID;
    if (!CUSTOM_THEME_ID_SET.has(theme)) {
      style.textContent = '';
      delete document.documentElement.dataset.rpTheme;
      return;
    }
    // 先标记 data-theme，新主题的 token 才已生效，组装色板时才能读到色值。
    document.documentElement.dataset.rpTheme = theme;
    const skin = buildCeramicSkin(theme);
    // 覆盖表在前、主题变量与控件规则在后，保证强调色和控件层级以主题为准。
    // 组件映射骨架最后：同特异性下由它决定按钮/控件/表格的最终外观。
    style.textContent = `${buildCss(skin)}\n${tokensFor(theme, skin)}\n${CONTROL_CSS}\n${buildComponentCss(theme)}`;
  };

  watchEffect(() => {
    const theme = userData.settings.theme ?? DEFAULT_THEME_ID;
    apply();
    if (!CUSTOM_THEME_ID_SET.has(theme)) {
      observer?.disconnect();
      observer = undefined;
      return;
    }
    if (observer) {
      return;
    }
    // 游戏会在启动后继续注入 CSS Modules 样式表，新增时重新生成覆盖表。
    observer = new MutationObserver(mutations => {
      const external = mutations.some(m =>
        [...m.addedNodes].some(node => node !== style && node.parentNode === document.head),
      );
      if (!external) {
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(apply, 250);
    });
    observer.observe(document.head, { childList: true });
  });
}

features.add(
  import.meta.url,
  init,
  `界面主题：切换整套界面配色（${THEMES.map(t => t.label).join(' / ')}），直接改颜色，保留期限告警的黄红标记，不影响图片与数据状态色。`,
);
