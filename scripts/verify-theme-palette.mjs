// 主题色板自检：`pnpm run verify:themes`
//
// 检查 src/features/basic/themes/<id>.css 的 token 色板是否仍然完整、可读、可用：
//   1) 结构：每个 token 主题一个精确块，块内只声明自定义属性；
//   2) 契约：token 名集合与 ceramic 完全一致（4 个可选 token 除外）；
//   3) 对比度：文字 / 控件 / 状态 / 分类各配对逐条过 WCAG 2.1 阈值；
//      「所有主题都达标」的组合才算硬门槛，个别主题的历史偏差只报不拦；
//   4) 预览：设置页卡片模拟窗口要读的 token 必须都在，且 THEME.vue 用到的
//      var(--rp-cc-*) 不得超出 theme-palette.ts 实际内联出去的那一组。
// 不依赖 postcss：色板块就是 `--rp-cc-*: 值;` 的扁平文本，按行解析足够。
import fs from 'node:fs';
import path from 'node:path';

const THEMES_DIR = 'src/features/basic/themes';
const REGISTRY = 'src/features/basic/theme-registry.ts';
const PALETTE_TS = 'src/features/basic/theme-palette.ts';
const CARD_VUE = 'src/features/XIT/SET/THEME.vue';
// 可选 token：主题不写就用引擎的默认值，不参与「与 ceramic 同名齐全」的比较。
const OPTIONAL = new Set([
  '--rp-cc-bg-image',
  '--rp-cc-neutral-shift',
  '--rp-cc-indicator-glow',
  '--rp-cc-indicator-line-soft',
]);
// 预览取哪些 token 只有一个事实源：theme-palette.ts 的 PREVIEW_TOKENS，脚本不另存一份。
const paletteTs = fs.readFileSync(PALETTE_TS, 'utf8');
const previewList = /const PREVIEW_TOKENS = \[([\s\S]*?)\] as const/.exec(paletteTs)?.[1] ?? '';
const PREVIEW_TOKENS = [...previewList.matchAll(/'(--rp-cc-[a-z0-9-]+)'/g)].map(m => m[1]);

let failures = 0;
const report = (ok, line) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${line}`);
};

// ── 注册表：谁是 token 主题、谁标了 dark ────────────────────────────
const registry = fs.readFileSync(REGISTRY, 'utf8');
// 每个注册项形如 { id: 'x', label: …, desc: …, mode: 'token', dark: true }，
// 逐条取 id + mode（mode 紧跟在 desc 之后，用非贪婪跨不过下一条）。
const entries = [...registry.matchAll(/id:\s*'([^']+)'[\s\S]*?mode:\s*'(\w+)'/g)];
const tokenIds = entries.filter(m => m[2] === 'token').map(m => m[1]);
if (!tokenIds.length) {
  console.error('注册表里找不到 token 主题，解析规则可能已失效');
  process.exit(1);
}
report(
  entries.every(m => ['native', 'token'].includes(m[2])),
  `注册表 mode 只剩 native / token（共 ${entries.length} 项：${entries.map(m => m[1]).join(', ')}）`,
);

// ── 色板块解析 ─────────────────────────────────────────────────────
const palettes = {};
for (const id of tokenIds) {
  const file = path.join(THEMES_DIR, `${id}.css`);
  if (!fs.existsSync(file)) {
    report(false, `${id} 缺少色板文件 ${file}`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const blocks = [
    ...text.matchAll(/html\[data-rp-theme='([^']+)'\](\s+body)?\s*\{([^}]*)\}/g),
  ].filter(m => m[1] === id && !m[2]);
  report(blocks.length === 1, `${id.padEnd(17)} 精确色板块 ${blocks.length} 个（应为 1）`);
  report(
    /html\[data-rp-theme='[^']*'\]\s+body\s*\{/.test(text),
    `${id.padEnd(17)} 有首屏防闪 body 块`,
  );
  const decls = {};
  const stray = [];
  for (const raw of (blocks[0]?.[3] ?? '').split(';')) {
    const line = raw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!line) continue;
    const m = /^([a-z0-9-]+)\s*:\s*(.+)$/is.exec(line);
    if (!m) {
      stray.push(line.slice(0, 40));
      continue;
    }
    if (!m[1].startsWith('--') && m[1] !== 'color-scheme') stray.push(m[1]);
    else decls[m[1]] = m[2].trim();
  }
  report(
    stray.length === 0,
    `${id.padEnd(17)} 块内无自定义属性以外的声明${stray.length ? '：' + stray.join(',') : ''}`,
  );
  palettes[id] = decls;
}

// ── token 名契约 ───────────────────────────────────────────────────
const ref = Object.keys(palettes['ceramic-colorful'] ?? {}).filter(k => k.startsWith('--rp-cc-'));
if (!ref.length) {
  console.error('ceramic 色板读不到，无法比对 token 契约');
  process.exit(1);
}
for (const id of tokenIds) {
  const mine = Object.keys(palettes[id] ?? {}).filter(k => k.startsWith('--rp-cc-'));
  const missing = ref.filter(t => !mine.includes(t));
  const extra = mine.filter(t => !ref.includes(t) && !OPTIONAL.has(t));
  report(
    !missing.length && !extra.length,
    `${id.padEnd(17)} token 契约 ${mine.length} 个${missing.length ? ' 缺:' + missing.join(',') : ''}${extra.length ? ' 多:' + extra.join(',') : ''}`,
  );
  const previewMiss = PREVIEW_TOKENS.filter(t => !palettes[id]?.[t]);
  report(
    PREVIEW_TOKENS.length >= 12 && !previewMiss.length,
    `${id.padEnd(17)} 模拟窗口 token${previewMiss.length ? ' 缺:' + previewMiss.join(',') : ` ${PREVIEW_TOKENS.length}/${PREVIEW_TOKENS.length} 齐`}`,
  );
}

// ── 颜色计算 ───────────────────────────────────────────────────────
const rgbOf = x => {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(x);
  if (hex) return [1, 2, 3].map(i => parseInt(hex[i], 16));
  const fn = /^rgba?\(([^)]+)\)$/i.exec(x.trim());
  if (!fn) return null;
  return fn[1]
    .split(',')
    .slice(0, 3)
    .map(v => parseFloat(v));
};
const alphaOf = x => (/^rgba/.test(x.trim()) ? parseFloat(x.split(',')[3]) : 1);
const over = (fg, bgArr) => {
  const [r, g, b] = rgbOf(fg);
  const a = alphaOf(fg);
  return [r * a + bgArr[0] * (1 - a), g * a + bgArr[1] * (1 - a), b * a + bgArr[2] * (1 - a)];
};
const onBase = (c, base) =>
  /^#/.test(c.trim()) ? rgbOf(c) : alphaOf(c) < 1 && base ? over(c, base) : null;
const lum = c => {
  const s = c.map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};
const contrast = (fg, bg, canvas) => {
  const bgArr = onBase(bg, rgbOf(canvas));
  if (!bgArr || !/^#|^rgba/.test(fg.trim())) return null;
  const f = lum(over(fg, bgArr));
  const b = lum(bgArr);
  return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
};

// ── 配对清单：文字 4.5:1，图形 / 边界 3:1 ──────────────────────────
const plates = ['--rp-cc-canvas', '--rp-cc-surface', '--rp-cc-surface-alt'];
const checks = p => {
  const list = [];
  const g = t => p[t];
  for (const t of [
    '--rp-cc-text-primary',
    '--rp-cc-text-secondary',
    '--rp-cc-text-muted',
    '--rp-cc-text-link',
    '--rp-cc-warn-accent',
    '--rp-cc-chart-label',
    '--rp-cc-chart-axis',
  ])
    plates.forEach(b => list.push([4.5, `${t} / ${b}`, g(t), g(b)]));
  for (const t of ['--rp-cc-accent-line', '--rp-cc-ring', '--rp-cc-border-focus'])
    plates.slice(0, 2).forEach(b => list.push([3, `${t} / ${b}`, g(t), g(b)]));
  for (const t of [
    '--rp-cc-border-strong',
    '--rp-cc-border-default',
    '--rp-cc-control-border',
    '--rp-cc-chart-grid',
  ])
    plates.slice(0, 2).forEach(b => list.push([3, `${t} / ${b}`, g(t), g(b)]));
  list.push([4.5, 'btn-primary', g('--rp-cc-btn-primary-text'), g('--rp-cc-btn-primary-bg')]);
  list.push([4.5, 'btn-secondary', g('--rp-cc-btn-secondary-text'), g('--rp-cc-btn-secondary-bg')]);
  list.push([4.5, 'btn-danger', g('--rp-cc-btn-danger-text'), g('--rp-cc-btn-danger-bg')]);
  list.push([4.5, 'btn-ghost', g('--rp-cc-btn-ghost-text'), g('--rp-cc-canvas')]);
  list.push([4.5, 'btn-link', g('--rp-cc-btn-link-text'), g('--rp-cc-canvas')]);
  list.push([4.5, 'control-text', g('--rp-cc-control-text'), g('--rp-cc-control-bg')]);
  list.push([
    4.5,
    'control-placeholder',
    g('--rp-cc-control-placeholder'),
    g('--rp-cc-control-bg'),
  ]);
  list.push([4.5, 'tooltip', g('--rp-cc-tooltip-text'), g('--rp-cc-tooltip-bg')]);
  list.push([4.5, 'table-head', g('--rp-cc-table-head-text'), g('--rp-cc-table-head-bg')]);
  for (const r of [
    '--rp-cc-table-row',
    '--rp-cc-table-row-alt',
    '--rp-cc-table-row-hover',
    '--rp-cc-table-row-selected',
  ])
    list.push([4.5, `table-text / ${r}`, g('--rp-cc-table-text'), g(r)]);
  for (const s of ['success', 'warning', 'danger', 'info']) {
    list.push([
      4.5,
      `status-${s}-text`,
      g(`--rp-cc-status-${s}-text`),
      g(`--rp-cc-status-${s}-bg`),
    ]);
    list.push([
      3,
      `status-${s}-border`,
      g(`--rp-cc-status-${s}-border`),
      g(`--rp-cc-status-${s}-bg`),
    ]);
  }
  for (let i = 1; i <= 8; i++) {
    list.push([4.5, `cat-${i}-text`, g(`--rp-cc-cat-${i}-text`), g(`--rp-cc-cat-${i}-bg`)]);
    list.push([3, `cat-${i}-chart / canvas`, g(`--rp-cc-cat-${i}-chart`), g('--rp-cc-canvas')]);
    list.push([3, `cat-${i}-chart / surface`, g(`--rp-cc-cat-${i}-chart`), g('--rp-cc-surface')]);
    list.push([3, `cat-${i}-border`, g(`--rp-cc-cat-${i}-border`), g(`--rp-cc-cat-${i}-bg`)]);
  }
  list.push([3, 'text-disabled', g('--rp-cc-text-disabled'), g('--rp-cc-btn-disabled-bg')]);
  return list;
};

const scores = {};
for (const id of tokenIds) {
  scores[id] = new Map(
    checks(palettes[id] ?? {}).map(([min, name, fg, bg]) => {
      const v = fg && bg ? contrast(fg, bg, palettes[id]['--rp-cc-canvas']) : null;
      return [name, { min, v }];
    }),
  );
}
const names = [...scores[tokenIds[0]].keys()];
// 硬门槛 = 全部主题都能达标；个别主题达不到的组合属历史偏差，只报不拦。
const gate = names.filter(n =>
  tokenIds.every(
    id => scores[id].get(n).v !== null && scores[id].get(n).v >= scores[id].get(n).min,
  ),
);
report(true, `对比度硬门槛 ${gate.length} 项 / 允许偏差 ${names.length - gate.length} 项`);
const soft = [];
for (const id of tokenIds) {
  for (const n of gate) {
    const { min, v } = scores[id].get(n);
    if (v !== null && v < min) soft.push(`${id} ${n} ${v.toFixed(2)} < ${min}`);
  }
  for (const n of names) {
    if (gate.includes(n)) continue;
    const { min, v } = scores[id].get(n);
    if (v !== null && v < min) soft.push(`${id} [软] ${n} ${v.toFixed(2)} < ${min}`);
  }
}
const hard = soft.filter(s => !s.includes('[软]'));
report(hard.length === 0, `硬门槛违例 ${hard.length} 项`);
hard.forEach(s => console.log('      ' + s));
if (soft.length - hard.length)
  console.log(
    `      允许偏差 ${soft.length - hard.length} 项（细边框、次级面文字等，项目既有口径）`,
  );

// ── 预览读取路径的回归护栏 ─────────────────────────────────────────
// CSSOM 会把 selectorText 里的属性值重新序列化成双引号，源码却是单引号；
// 谁要是再拿 `=== "html[data-rp-theme='x']"` 去比，模拟窗口会静默变成兜底色。
report(
  !/selectorText\s*===?\s*['"`]html\[data-rp-theme='/.test(paletteTs),
  'theme-palette.ts 不用单引号字面量硬比 selectorText',
);
report(
  /data-rp-theme=\["'\]\?/.test(paletteTs) || /data-rp-theme=\["'\]/.test(paletteTs),
  'theme-palette.ts 的选择器匹配忽略引号',
);
const codeOnly = paletteTs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
report(
  !/\.style\.getPropertyValue\(/.test(codeOnly) && /function tokenValue/.test(codeOnly),
  'theme-palette.ts 从 cssText 取 token 值',
);

// 窗口里每写一个 var(--rp-cc-*)，PREVIEW_TOKENS 就得同步收录；漏一个不会报错，
// 只会静默少一层颜色，所以这里当硬门槛拦下来。THEME.vue 也不许再写颜色字面量，
// 否则预览就有第二份色板，切主题时会互相盖。
const cardCss = fs.readFileSync(CARD_VUE, 'utf8');
const cardVars = [...new Set([...cardCss.matchAll(/var\((--rp-cc-[a-z0-9-]+)/g)].map(m => m[1]))];
const uncovered = cardVars.filter(t => !PREVIEW_TOKENS.includes(t));
report(
  cardVars.length > 0 && !uncovered.length,
  `THEME.vue 模拟窗口的 ${cardVars.length} 个 var() 全部在 PREVIEW_TOKENS 内${uncovered.length ? ' 缺:' + uncovered.join(',') : ''}`,
);
const cardColors = cardCss.match(/#[\da-f]{3,8}\b|\brgba?\(\s*[\d.]+/gi) ?? [];
report(
  !cardColors.length,
  `THEME.vue 不写颜色字面量（违例 ${cardColors.length}：${cardColors.slice(0, 3).join(' ')}）`,
);
const nativeBlock = /const NATIVE_PREVIEW[\s\S]*?\n\};/.exec(paletteTs)?.[0] ?? '';
const nativeMiss = PREVIEW_TOKENS.filter(t => !nativeBlock.includes(`'${t}'`));
report(
  !!nativeBlock && !nativeMiss.length,
  `原样卡片的 NATIVE_PREVIEW 覆盖 PREVIEW_TOKENS${nativeMiss.length ? ' 缺:' + nativeMiss.join(',') : ''}`,
);

console.log(failures ? `\n${failures} 项 FAIL` : '\nALL PASS');
process.exit(failures ? 1 : 0);
