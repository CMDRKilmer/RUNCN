// 设置页主题卡片的模拟窗口：颜色只从各主题色板块读取，不在这里复制第二份色值。
//
// 色板是样式表里的精确块 `html[data-rp-theme='<id>']`（src/features/basic/themes/<id>.css，
// 构建时合并进 dist/refined-prun.css），所以任何主题——包括当前没用上的——都能直接读。
// 原样主题（mode:'native'）没有色板块，走下面那份 NATIVE_PREVIEW。
//
// 取值要内联到卡片元素上，而不是给卡片挂 data-rp-theme：色板选择器锚在 html 上，
// 嵌套元素挂同名属性也命中不了，只能把这组 token 作为自定义属性交给窗口。
//
// 两处不按直觉写，都是踩过的坑：
//   · 选择器比对必须忽略引号。源码与产物里都是单引号，但 CSSOM 会把 selectorText 里的
//     属性值重新序列化成双引号，用 `=== "html[data-rp-theme='light']"` 永远匹配不上。
//   · 取值走 cssText 而不是 rule.style.getPropertyValue()：自定义属性在 CSSStyleDeclaration
//     上的支持不如普通属性稳，规则原文里一定有 `--rp-cc-*: 值;`，直接读文本最可靠。
import { themeById } from '@src/features/basic/theme-registry';

/** 模拟窗口取的色：窗底、标题栏、正文、表格、输入框、两类按钮、三档图形色、状态绿、指示线。 */
export const PREVIEW_TOKENS = [
  '--rp-cc-canvas',
  '--rp-cc-surface-alt',
  '--rp-cc-table-head-bg',
  '--rp-cc-table-head-text',
  '--rp-cc-text-secondary',
  '--rp-cc-table-border',
  '--rp-cc-table-row-alt',
  '--rp-cc-table-text',
  '--rp-cc-control-bg',
  '--rp-cc-control-border',
  '--rp-cc-btn-primary-bg',
  '--rp-cc-btn-danger-bg',
  '--rp-cc-cat-1-chart',
  '--rp-cc-cat-4-chart',
  '--rp-cc-cat-6-chart',
  '--rp-cc-status-success-text',
  '--rp-cc-accent-line',
] as const;

export type ThemePreviewVars = Partial<Record<(typeof PREVIEW_TOKENS)[number], string>>;

// 原样主题的预览色板。它不参与主题引擎、不进任何 CSS，只为让「原样」卡片也能画出
// 同一个窗口；每个值都取自仓库里既有的原生深色兜底，不新造颜色：
//   rgb(26,33,38)  面板底（各 XIT 组件的 --rp-skin-panel 兜底）
//   rgb(36,44,52)  表头 / 斑马纹（既有原生灰阶里出现最多的那一档）
//   rgb(46,56,64)  控件描边；rgb(61,74,84) 卡片强描边
//   #1a2632        输入框底（--rp-skin-input-bg 兜底）
//   #f0ad4e / #9c3b3b / #5cb85c 原生主按钮 / 卖出红 / 动作绿
//   chart-theme.ts 的 FALLBACK：#004564 / #00846c / #ada900 序列色，#f7a600 强调线，#ccc 标签字
const NATIVE_PREVIEW: ThemePreviewVars = {
  '--rp-cc-canvas': 'rgb(26, 33, 38)',
  '--rp-cc-surface-alt': 'rgb(36, 44, 52)',
  '--rp-cc-table-head-bg': 'rgb(36, 44, 52)',
  '--rp-cc-table-head-text': '#cccccc',
  '--rp-cc-text-secondary': '#b8c2ca',
  '--rp-cc-table-border': 'rgb(61, 74, 84)',
  '--rp-cc-table-row-alt': 'rgb(36, 44, 52)',
  '--rp-cc-table-text': '#cccccc',
  '--rp-cc-control-bg': '#1a2632',
  '--rp-cc-control-border': 'rgb(46, 56, 64)',
  '--rp-cc-btn-primary-bg': '#f0ad4e',
  '--rp-cc-btn-danger-bg': '#9c3b3b',
  '--rp-cc-cat-1-chart': '#004564',
  '--rp-cc-cat-4-chart': '#00846c',
  '--rp-cc-cat-6-chart': '#ada900',
  '--rp-cc-status-success-text': '#5cb85c',
  '--rp-cc-accent-line': '#f7a600',
};

const cache = new Map<string, ThemePreviewVars>();

function paletteRuleText(id: string): string {
  // id 只可能是注册表里的小写字母 / 连字符，仍需转义以防万一
  const safe = id.replace(/[^\w-]/g, '');
  const selector = new RegExp(`^html\\[data-rp-theme=["']?${safe}["']?\\]$`);
  // 优先用 startup 注入的那张表本身（refined-prun-startup.ts 就是读它的
  // cssRules 建索引的，这条路径已被证明可用），再兜底扫全文档样式表。
  const link = document.getElementById('refined-prun-css') as HTMLLinkElement | null;
  const sheets: (CSSStyleSheet | null)[] = [link?.sheet ?? null, ...document.styleSheets];
  for (const sheet of sheets) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet?.cssRules;
    } catch {
      // 跨源样式表读不到规则，本扩展的样式表不受影响。
      continue;
    }
    if (!rules) {
      continue;
    }
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && selector.test(rule.selectorText.trim())) {
        return rule.cssText;
      }
    }
  }
  return '';
}

function tokenValue(block: string, token: string): string {
  const m = new RegExp(`${token}:\\s*([^;}]+)`).exec(block);
  return m ? m[1].trim() : '';
}

/** 卡片模拟窗口的内联自定义属性；原样主题走 NATIVE_PREVIEW。 */
export function themePreviewVars(id: string): ThemePreviewVars {
  const hit = cache.get(id);
  if (hit) {
    return hit;
  }
  const out: ThemePreviewVars = {};
  if (themeById(id)?.mode === 'native') {
    Object.assign(out, NATIVE_PREVIEW);
  } else {
    const block = paletteRuleText(id);
    for (const token of PREVIEW_TOKENS) {
      const value = tokenValue(block, token);
      if (value) {
        out[token] = value;
      }
    }
  }
  cache.set(id, out);
  return out;
}
