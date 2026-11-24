// XIT SET「功能」页的分组标签。
//
// 归类顺序：显式映射 → 命令前缀规则 → 界面类命名启发式 → 「其他」。
// 新功能只要沿用既有命名（inv- / flt- / cx… ）就会自动落到对应组；
// 前缀兜不住的（隐藏类、跨域工具）在 EXPLICIT 里补一行即可。
// 开发模式下未命中会在 feature-registry 里打一条 warn，提醒补登记。

export type FeatureGroupId = 'ui' | 'base' | 'inv' | 'fleet' | 'market' | 'social' | 'other';

export interface FeatureGroupInfo {
  id: FeatureGroupId;
  /** 标签上显示的名字 */
  name: string;
  /** 悬浮说明：这一组管什么 */
  hint: string;
}

export const FEATURE_GROUPS: readonly FeatureGroupInfo[] = [
  { id: 'ui', name: '界面与外观', hint: '隐藏 / 压缩 / 配色 / 图标 / 字体、磁贴与窗口行为' },
  { id: 'base', name: '基地与生产', hint: 'BS 基地、BBL 建筑、BRA 维修、PROD 生产、COGC 商会、HQ' },
  {
    id: 'inv',
    name: '库存与物料',
    hint: 'INV 库存、SHPI 货舱、BLCK 打包、MAT 物料、MTRA 转移、BLU 蓝图',
  },
  { id: 'fleet', name: '船队与航线', hint: 'FLT 舰队、SFC 航行控制、RTE / RT 航线、NX 补油' },
  { id: 'market', name: '市场与交易', hint: 'CX 系列交易所、LM 广告、LEAD 排行、价格提示' },
  { id: 'social', name: '合同·通讯·社交', hint: 'CONTD / CONT 合同、COM 聊天、NOTS 通知、CO 公司' },
  { id: 'other', name: '其他 / 工具', hint: '自动化、别名、命令修正、财务表、杂项' },
];

// 前缀规则兜不住的功能：名单来自人工归类，新增功能时按需补在这里。
// 前缀规则能覆盖的（inv- / flt- / cx…）不必登记。
const EXPLICIT: Readonly<Record<string, FeatureGroupId>> = {
  'context-controls-no-hover': 'ui',
  'finla-hide-ecd': 'other',
  'pli-cogc-label': 'base',
  'wf-workforce-filters': 'base',
  'align-chat-delete-button': 'social',
  'auto-load-products': 'fleet',
  'auto-refuel': 'fleet',
  'auto-resize-buffers': 'ui',
  'browser-tab-name': 'ui',
  'bui-sort-recipes': 'base',
  'clickable-apex-logo': 'ui',
  'exp-expert-eta': 'base',
  'expand-sidebar-contract-list': 'social',
  'focus-buffers-on-click': 'ui',
  'funny-materials': 'ui',
  'highlight-own-exchange-orders': 'market',
  'highlight-production-order-error': 'base',
  'material-price-tooltips': 'market',
  'other-context-notification-count': 'social',
  'prevent-delete-button-misclicks': 'social',
  'rprun-version-label': 'ui',
  'search-auto-focus': 'ui',
  'sysi-blue-negative-value': 'ui',
  'audio-volume-slider': 'ui',
  'close-all-buffers': 'ui',
  'custom-left-sidebar': 'ui',
  'shipping-per-unit-price': 'market',
  'sidebar-contracts-details': 'social',
};

// 命令前缀 → 分组。键统一按小写比较（功能 id 里既有 inv-… 也有 NX 这种大写）。
const PREFIX_RULES: readonly (readonly [FeatureGroupId, RegExp])[] = [
  ['base', /^(bs|bbl|bbc|bra|prod|prodq|prodco|cogc|cogcu|cogcpex|hq|adm|contribution)(-|$)/],
  ['inv', /^(inv|shpi|shp|blck|mat|mtra|blu|war)(-|$)/],
  ['fleet', /^(flt|sfc|rte|rt|nx|burn)(-|$)/],
  ['market', /^(cx|cxob|cxos|cxpo|cxpc|cxo|lm|lma|lmp|lead)(-|$)/],
  ['social', /^(contd|cont|conts|chat|nots|corp|gov|govh|co)(-|$)/],
];

// 界面类功能的命名习惯：隐藏 / 压缩 / 配色 / 图标 / 字体 / 窗口行为。
const UI_PATTERNS: readonly RegExp[] = [
  /^hide-/,
  /^always-visible-/,
  /^minimize-/,
  /^shorten-/,
  /-hide-/,
  /^header-/,
  /^screen-/,
  /-compact$/,
  /-colors$/,
  /-icons$/,
  /-font/,
  /-shadow/,
  /-background$/,
];

export type FeatureGroupSource = 'explicit' | 'prefix' | 'fallback';

/** 解析某功能所属分组，并说明是哪条规则命中的（fallback 表示落到了「其他」）。 */
export function resolveFeatureGroup(id: string): {
  group: FeatureGroupId;
  source: FeatureGroupSource;
} {
  const explicit = EXPLICIT[id];
  if (explicit !== undefined) {
    return { group: explicit, source: 'explicit' };
  }
  const key = id.toLowerCase();
  for (const [group, pattern] of PREFIX_RULES) {
    if (pattern.test(key)) {
      return { group, source: 'prefix' };
    }
  }
  if (UI_PATTERNS.some(pattern => pattern.test(key))) {
    return { group: 'ui', source: 'prefix' };
  }
  return { group: 'other', source: 'fallback' };
}

export function getFeatureGroup(id: string): FeatureGroupId {
  return resolveFeatureGroup(id).group;
}
