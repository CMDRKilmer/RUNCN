// Chart.js / canvas 的主题颜色映射。
//
// canvas 的 fillStyle 不认识 var()，所以这里把 CSS 语义 token 解析成具体色值。
// 只在注册表中 mode:'token' 的主题下取 token；其余主题一律返回原组件的
// 默认色板，保证原样 / 浅色明亮 / 暖米纸的图表外观一字不变。
// 读取 userData.settings.theme 是为了让 Vue computed 建立响应式依赖：
// 用户在 XIT SET 里切换主题时图表会重新取色。
import { userData } from '@src/store/user-data';
import { usesTokenPalette } from '@src/features/basic/theme-registry';

const FALLBACK = {
  series: ['#004564', '#005b76', '#007079', '#00846c', '#009552', '#67a22e', '#ada900', '#f7a600'],
  line: '#f7a600',
  label: '#eeeeee',
  grid: '#505050',
  tick: '#999',
  datalabel: '#cccccc',
};

export interface ChartColors {
  series: string[];
  line: string;
  label: string;
  grid: string;
  tick: string;
  datalabel: string;
}

export function chartColors(): ChartColors {
  const theme = userData.settings.theme;
  if (!usesTokenPalette(theme)) {
    return FALLBACK;
  }
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string): string => {
    const resolved = style.getPropertyValue(name).trim();
    return /^#[\da-f]{6}$/i.test(resolved) ? resolved : fallback;
  };
  return {
    series: FALLBACK.series.map((fallback, i) => value(`--rp-cc-cat-${i + 1}-chart`, fallback)),
    line: value('--rp-cc-cat-1-chart', FALLBACK.line),
    label: value('--rp-cc-chart-label', FALLBACK.label),
    grid: value('--rp-cc-chart-grid', FALLBACK.grid),
    tick: value('--rp-cc-chart-axis', FALLBACK.tick),
    datalabel: value('--rp-cc-text-primary', FALLBACK.datalabel),
  };
}
