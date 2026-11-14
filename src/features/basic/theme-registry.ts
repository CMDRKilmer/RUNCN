// 界面主题注册表 —— 主题元数据的唯一事实源。
//
// 约束：
//  1. 本文件必须保持「纯数据、零依赖」。refined-prun-startup.ts 会在页面脚本
//     启动早期（React 首次绘制之前）引用它，此时 store / 主题引擎 / DOM 都还
//     没就绪，任何 import 副作用都会破坏首屏。
//  2. 新增主题只需在这里加一行 + 按 mode 提供一份色板；id / 说明 / ThemeId /
//     设置页卡片 / 引擎可识别集合 / 首屏防闪 / 图表取色全部自动跟随。
//  3. 历史数据迁移（user-data-migrations.ts）里的主题 id 必须硬编码，禁止引用
//     本文件：迁移描述的是「当时的数据」，不能随注册表一起变化。
//  4. 任何主题逻辑的改动，都必须同步检查：原样主题（default）不受影响、
//     自定义主题的取色全部走 var(--rp-skin-*)、图表有回退色板。

/** 主题的实现模式，决定引擎走哪条路径。 */
export type ThemeMode = 'native' | 'skin' | 'token';

export interface ThemeDefinition {
  /** userData.settings.theme 的值，同时也是 html[data-rp-theme] 的值。 */
  id: string;
  /** XIT SET THEME 卡片标题。 */
  label: string;
  /** XIT SET THEME 卡片说明。 */
  desc: string;
  /**
   * native：游戏原生外观。不注入覆盖表、不写 data-rp-theme。全表只能有一个。
   * skin ：色板写在 theme.ts 的 SKINS 里，--rp-skin-* 由 tokensFor() 注入；
   *        走通用 CONTROL_CSS，不做组件类型级映射。
   * token：色板写在 refined-prun.css 的 html[data-rp-theme='<id>'] 块里，
   *        --rp-cc-* 是唯一颜色字面量来源；引擎从 token 组装 Skin，并复用
   *        buildComponentCss(<id>) 生成组件类型 → token 的映射骨架。
   *        token 模式自动获得：首屏防闪标记、图表 token 取色。
   */
  mode: ThemeMode;
}

export const THEMES = [
  {
    id: 'default',
    label: '原样',
    desc: '游戏原生深色界面 + 橙金强调色，等于不启用主题。',
    mode: 'native',
  },
  {
    id: 'light',
    label: '浅色明亮',
    desc: '浅底深字、低饱和：窗口、表格、按钮、物料图标、输入框统一重配色，彩色收敛为石板蓝；保留黄红异常标记，图片与涨跌含义不变。',
    mode: 'skin',
  },
  {
    id: 'paper',
    label: '暖米纸',
    desc: '参考暖色纸张界面：淡米白底、近白卡片、卡其细边框，赭金强调搭配小面积墨绿与暗红；低饱和暖调，黄红异常标记照旧保留。',
    mode: 'skin',
  },
  {
    id: 'ceramic-colorful',
    label: '陶瓷白多彩',
    desc: '暖陶瓷白底 + 近白卡片，8 个低饱和色相只用于分类标签、图表、图标、装饰线与状态提示；按钮/表单/表格按组件类型统一，正文、焦点态与禁用态经 WCAG 对比度校验。',
    mode: 'token',
  },
  {
    id: 'nebula',
    label: '星海霓虹',
    desc: '参考深空星海科幻界面：近黑深蓝底 + 半透明玻璃面板，青蓝霓虹（#35c4e8）作为唯一主强调色贯穿选中态/主按钮/边框发光；金/绿/红/紫/青绿/玫红/蓝/黄八类功能彩色各司其职、同类同色，信息编码不刺眼。',
    mode: 'token',
  },
] as const satisfies readonly ThemeDefinition[];

/** 设置项与 data-rp-theme 的合法取值，从注册表派生，不再手工维护。 */
export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME_ID: ThemeId = 'default';

/**
 * 当前 token 模式主题的默认 id。theme-ceramic.ts 的命名与它绑定。
 * 引擎判断一律用 usesTokenPalette()（基于 mode），禁止用这个常量做分支，
 * 否则新增第二个 token 主题时会被漏掉。
 */
export const CERAMIC_THEME_ID: ThemeId = 'ceramic-colorful';

/** 需要注入覆盖表的自定义主题（原样主题除外）。 */
export const CUSTOM_THEME_IDS: readonly ThemeId[] = THEMES.filter(t => t.mode !== 'native').map(
  t => t.id,
);
export const CUSTOM_THEME_ID_SET: ReadonlySet<string> = new Set<string>(CUSTOM_THEME_IDS);

export function themeById(id: string | undefined | null): ThemeDefinition | undefined {
  return THEMES.find(t => t.id === id);
}

/** 未知 / 未设置一律当原样主题，保证存量数据不会误触发覆盖表。 */
export function themeMode(id: string | undefined | null): ThemeMode {
  return themeById(id)?.mode ?? 'native';
}

export function isCustomTheme(id: string | undefined | null): boolean {
  return themeMode(id) !== 'native';
}

/** token 模式：色板在 CSS 里，需要首屏提前打标记、图表走 token 取色。 */
export function usesTokenPalette(id: string | undefined | null): boolean {
  return themeMode(id) === 'token';
}

/** 首屏防闪白名单：色板在 CSS 里的主题必须在 React 首次绘制前就位。 */
export const needsStartupMarker = usesTokenPalette;
