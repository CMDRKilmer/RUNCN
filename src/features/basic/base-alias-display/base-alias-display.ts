// 在所有显示该星球的地方附加基地别名。
//
// 性能设计：
// - 只在已确定属于某个 base 的 tile 内装饰，绝不扫描整个 body。
// - 链接装饰用 requestIdleCallback 推迟到浏览器空闲期，且每个 tile 只对
//   同一种别名装饰一次（anchor.dataset 记录已装饰的别名版本）。
// - 每个 tile 只挂一个 watchEffect（标题装饰）；链接装饰由全局 watcher 统一
//   调度，不在每个 tile 上重复注册 node-disconnected 回调。

import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getBaseAlias } from '@src/core/base-aliases';
import { userData } from '@src/store/user-data';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';

const TITLE_SEPARATOR = ' · ';
const ALIAS_OPEN = '（';
const ALIAS_CLOSE = '）';

const NATURAL_ID_RE = /[A-Z]{2,3}-\d{3,4}[a-z]?/g;

function findSiteByTileParameter(parameter: string | undefined) {
  if (!parameter) {
    return undefined;
  }
  const direct = sitesStore.getById(parameter);
  if (direct) {
    return direct;
  }
  const byName =
    sitesStore.getByPlanetNaturalId(parameter) ?? sitesStore.getByPlanetName(parameter);
  if (byName) {
    return byName;
  }
  const lower = parameter.toLowerCase();
  const stores = storagesStore.all.value ?? [];
  const store = stores.find(x => x.id.toLowerCase().startsWith(lower));
  if (store) {
    // 基地库存：addressableId 就是 siteId。
    const site = sitesStore.getById(store.addressableId);
    if (site) {
      return site;
    }
    // 仓库库存：addressableId 是 warehouseId，需经仓库地址解析出所在行星。
    const warehouse = warehousesStore.getById(store.addressableId);
    if (warehouse) {
      const naturalId = getEntityNaturalIdFromAddress(warehouse.address);
      if (naturalId) {
        return sitesStore.getByPlanetNaturalId(naturalId);
      }
    }
  }
  return sitesStore.getByPlanetNaturalIdOrName(parameter);
}

function findSiteByXitParameters(parameters: string[]) {
  for (const param of parameters) {
    const site =
      sitesStore.getByPlanetNaturalId(param) ??
      sitesStore.getByPlanetName(param) ??
      sitesStore.getByPlanetNaturalIdOrName(param);
    if (site) {
      return site;
    }
  }
  return undefined;
}

function decorateTitleWithAlias(title: HTMLElement, alias: string) {
  let span = title.querySelector(':scope > span[data-base-alias]') as HTMLElement | null;
  if (!span) {
    span = document.createElement('span');
    title.appendChild(span);
  }
  const text = alias ? `${TITLE_SEPARATOR}${alias}` : '';
  if (span.textContent !== text) {
    span.textContent = text;
  }
}

function resolveAliasForNaturalId(naturalId: string): string {
  const site = sitesStore.getByPlanetNaturalId(naturalId);
  if (!site) {
    return '';
  }
  return getBaseAlias(site.siteId) ?? '';
}

function resolveAliasForPlanetName(name: string): string {
  const site = sitesStore.getByPlanetName(name);
  if (!site) {
    return '';
  }
  return getBaseAlias(site.siteId) ?? '';
}

function resolveAliasFromText(text: string): string {
  NATURAL_ID_RE.lastIndex = 0;
  // 取最后一个 naturalId：PrUn 的行星链接文本形如
  //   "PD-754 - Ashland (PD-754d)"（系统 naturalId 在前、行星 naturalId 在括号里）
  //   "Wet Water - Boucher (FK-794b)"（命名系统无 naturalId）
  //   "Shardonia c (VH-192c)"
  // 行星 naturalId 总是最后一个（括号内的完整标识符）。
  let lastMatch = '';
  let m: RegExpExecArray | null;
  while ((m = NATURAL_ID_RE.exec(text)) !== null) {
    lastMatch = m[0];
  }
  if (lastMatch) {
    return resolveAliasForNaturalId(lastMatch);
  }
  let trimmed = text.trim();
  while (trimmed.endsWith(ALIAS_CLOSE)) {
    const openIdx = trimmed.lastIndexOf(ALIAS_OPEN);
    if (openIdx < 0) {
      break;
    }
    trimmed = trimmed.slice(0, openIdx).trimEnd();
  }
  if (trimmed.length === 0 || trimmed.length > 60) {
    return '';
  }
  if (/^[\d$¥€£,\s.\-+()]+$/.test(trimmed)) {
    return '';
  }
  return resolveAliasForPlanetName(trimmed);
}

// 给单个链接追加 / 更新别名后缀。
function applyAliasSuffix(el: HTMLElement, alias: string) {
  const suffixText = `${ALIAS_OPEN}${alias}${ALIAS_CLOSE}`;
  // 快速路径：直接找直接子级的后缀 span。
  for (const child of Array.from(el.children)) {
    if (child.hasAttribute('data-base-alias-suffix')) {
      if (child.textContent === suffixText) {
        return;
      }
      child.textContent = suffixText;
      return;
    }
  }
  const suffix = document.createElement('span');
  suffix.dataset.baseAliasSuffix = '';
  suffix.textContent = suffixText;
  el.appendChild(suffix);
}

// 给某个 tile 的 anchor 子树内所有 <a> / Link__link div 追加别名后缀。
// anchor.dataset.baseAliasDone 记录已装饰的别名版本，相同则整体跳过。
function decorateLinksInRoot(tile: PrunTile, alias: string) {
  const anchor = tile.anchor;
  if (anchor.dataset.baseAliasDone === alias) {
    return;
  }
  if (anchor.dataset.baseAliasDone !== undefined && anchor.dataset.baseAliasDone !== alias) {
    // 别名变化：清除旧后缀（每个链接内的直接子 span）。
    for (const suffix of Array.from(anchor.querySelectorAll('[data-base-alias-suffix]'))) {
      suffix.remove();
    }
  }
  // 用 getElementsByTagName / getElementsByClassName 替代 querySelectorAll 属性选择器，
  // 后者（[class*="Link__link"]）要全树扫描，是之前卡顿的来源之一。
  const links = new Set<HTMLElement>();
  for (const a of Array.from(anchor.getElementsByTagName('a'))) {
    links.add(a as HTMLElement);
  }
  for (const div of Array.from(anchor.getElementsByClassName(C.Link.link))) {
    links.add(div as HTMLElement);
  }
  for (const el of links) {
    const text = el.textContent;
    if (!text || !text.trim()) {
      continue;
    }
    // 若链接里已经有后缀，跳过（避免对同一链接重复 append）。
    let hasSuffix = false;
    for (const child of Array.from(el.children)) {
      if (child.hasAttribute('data-base-alias-suffix')) {
        hasSuffix = true;
        break;
      }
    }
    if (hasSuffix) {
      continue;
    }
    const linkAlias = resolveAliasFromText(text);
    if (linkAlias.length > 0) {
      applyAliasSuffix(el, linkAlias);
    }
  }
  anchor.dataset.baseAliasDone = alias;
}

const tileSites = new Map<PrunTile, PrunApi.Site>();

// 用 requestIdleCallback 推迟到空闲期执行；执行前再次校验 tile 仍连接。
function scheduleLinkDecoration(tile: PrunTile, site: PrunApi.Site) {
  const run = () => {
    if (!tile.frame.isConnected) {
      return;
    }
    const alias = getBaseAlias(site.siteId) ?? '';
    if (alias.length > 0) {
      decorateLinksInRoot(tile, alias);
    }
  };
  const ric = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (ric) {
    ric(run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}

function onTileReady(tile: PrunTile) {
  let site = findSiteByTileParameter(tile.parameter);
  if (!site && tile.command === 'XIT') {
    const rawParameter = tile.parameter ?? '';
    const keyValues = rawParameter.split(/[_ ]+/g);
    const xitParameters = rawParameter[0] === '1' ? keyValues.map(x => x.slice(2)) : keyValues;
    site = findSiteByXitParameters(xitParameters.slice(1));
  }
  if (!site) {
    return;
  }
  const titleEl = _$(tile.frame, C.TileFrame.title) as HTMLElement | undefined;
  if (!titleEl) {
    return;
  }
  // 标题装饰：每个 tile 只挂这一个 watcher。aliasRef 变化（别名 / 数据就绪）时更新标题。
  const aliasRef = computed(() => getBaseAlias(site.siteId) ?? '');
  watchEffectWhileNodeAlive(titleEl, () => {
    decorateTitleWithAlias(titleEl, aliasRef.value);
  });
  // XIT 模块（FLEET/BS、PROD、BURN、EXP、WFOR 等）已在 Vue 组件内原生渲染别名，
  // 不再需要 DOM 链接装饰（避免双重显示与性能开销）。
  // PrUn 原生 tile（BS、INV、PROD、BBL 等）的内容由游戏渲染，仍需链接装饰。
  if (tile.command !== 'XIT') {
    tileSites.set(tile, site);
    scheduleLinkDecoration(tile, site);
  }
}

function rescheduleAll() {
  for (const [tile, site] of tileSites) {
    if (!tile.frame.isConnected) {
      tileSites.delete(tile);
      continue;
    }
    scheduleLinkDecoration(tile, site);
  }
}

function init() {
  tiles.observeAll(onTileReady);

  // 别名变化：标题由各 tile 的 aliasRef 自动更新；链接装饰统一重调度。
  watchEffect(() => {
    for (const alias of Object.values(userData.baseAliases)) {
      void alias;
    }
    rescheduleAll();
  });

  // sites 加载完成后重调度一次（naturalId → site 解析依赖 sites）。
  watchEffect(() => {
    if (sitesStore.fetched.value) {
      rescheduleAll();
    }
  });
}

features.add(
  import.meta.url,
  init,
  '在面板标题与该 panel 内的链接后追加基地别名（（别名）格式），修改别名立即生效。',
);
