import $style from './material-price-tooltips.module.css';
import { cxStore } from '@src/infrastructure/fio/cx';
import type { TickerPriceInfo } from '@src/infrastructure/fio/cx';
import { getMaterialNameByTicker } from '@src/core/game-lookups';
import { userData } from '@src/store/user-data';
import { fixed0, fixed02, hhmm } from '@src/utils/format';

// 只展示常用的四个交易所。CI2 / NC2 / UNIVERSE 不显示、不读取、也不参与计算。
const exchangeOrder = ['AI1', 'CI1', 'IC1', 'NC1'];

interface PriceRow {
  label: string;
  value: (info: TickerPriceInfo) => number | null | undefined;
  withTotal: boolean;
}

const rows: PriceRow[] = [
  { label: '卖价', value: x => x.Ask, withTotal: true },
  { label: '买价', value: x => x.Bid, withTotal: true },
  { label: '均价', value: x => x.PriceAverage, withTotal: true },
  { label: '供给', value: x => x.Supply, withTotal: false },
  { label: '需求', value: x => x.Demand, withTotal: false },
];

let tooltip: HTMLElement | null = null;

function isEnabled() {
  return userData.settings.pricing.materialPriceTooltips === true;
}

function getExchanges() {
  if (!cxStore.fetched) {
    return [];
  }
  // 按白名单取列，不遍历整个价格表，因此不会读取 CI2 / NC2 / UNIVERSE 的数据。
  return exchangeOrder.filter(code => cxStore.prices.has(code));
}

function getTicker(container: Element) {
  const label = container.querySelector(`.${C.ColoredIcon.label}`);
  const text = label?.textContent?.trim();
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  return text;
}

function getAmount(container: Element) {
  const scope = container.parentElement ?? container;
  const classNames = [C.MaterialIcon.typeVerySmall, C.ColoredIcon.typeVerySmall];
  for (const className of classNames) {
    const node = scope.querySelector(`.${className}`);
    const text = node?.textContent?.replaceAll(',', '').trim();
    if (text === undefined || text.length === 0) {
      continue;
    }
    const amount = Number(text);
    if (Number.isFinite(amount) && amount > 0) {
      return amount;
    }
  }
  return undefined;
}

function formatValue(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return '--';
  }
  return value >= 100 ? fixed0(value) : fixed02(value);
}

// 一个单元格内上下两行：第一行单价，第二行按当前数量的合计金额。
function createPriceCell(value: number | null | undefined, amount?: number) {
  const cell = document.createElement('td');
  cell.className = $style.value;

  const price = document.createElement('div');
  price.className = $style.price;
  price.textContent = formatValue(value);
  cell.appendChild(price);

  const total = document.createElement('div');
  total.className = $style.total;
  total.textContent =
    amount !== undefined && value !== undefined && value !== null ? fixed0(value * amount) : '';
  cell.appendChild(total);
  return cell;
}

function createCell(tag: 'th' | 'td', text: string, className?: string) {
  const cell = document.createElement(tag);
  cell.textContent = text;
  if (className !== undefined) {
    cell.className = className;
  }
  return cell;
}

function createTooltip(container: Element) {
  const ticker = getTicker(container);
  if (ticker === undefined) {
    return undefined;
  }
  const exchanges = getExchanges();
  const amount = getAmount(container);

  const root = document.createElement('div');
  root.className = $style.tooltip;
  root.setAttribute('role', 'tooltip');

  // 游戏自带的本地化物料名（当前语言为中文），缺失时只显示缩写，不回退英文全称。
  const materialName = getMaterialNameByTicker(ticker);
  const title = document.createElement('div');
  title.className = $style.title;
  title.textContent = materialName !== undefined ? `${ticker} · ${materialName}` : ticker;
  root.appendChild(title);

  if (exchanges.length === 0) {
    const empty = document.createElement('div');
    empty.className = $style.empty;
    empty.textContent = '价格数据加载中…';
    root.appendChild(empty);
    return root;
  }

  const table = document.createElement('table');
  table.className = $style.table;
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(createCell('th', ''));
  for (const code of exchanges) {
    headRow.appendChild(createCell('th', code));
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(createCell('td', row.label, $style.label));
    for (const code of exchanges) {
      const info = cxStore.prices.get(code)?.get(ticker);
      const value = info !== undefined ? row.value(info) : undefined;
      // 价格行显示「单价 / 合计」两行；供给、需求只有数量，用单行文本格，
      // 不生成第二行空占位，避免该行被撑成两行高度。
      const cell = row.withTotal
        ? createPriceCell(value, amount)
        : createCell('td', formatValue(value), $style.value);
      tr.appendChild(cell);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  root.appendChild(table);

  const footer = document.createElement('div');
  footer.className = $style.footer;
  footer.textContent = `价格更新 ${hhmm(cxStore.age)}`;
  root.appendChild(footer);
  return root;
}

function positionTooltip(container: Element, content: HTMLElement) {
  const rect = container.getBoundingClientRect();
  const margin = 8;
  const width = content.offsetWidth;
  const height = content.offsetHeight;
  let left = rect.right + margin;
  if (left + width > window.innerWidth) {
    left = rect.left - width - margin;
  }
  left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
  let top = rect.top + (rect.height - height) / 2;
  top = Math.max(4, Math.min(top, window.innerHeight - height - 4));
  content.style.left = `${left}px`;
  content.style.top = `${top}px`;
}

function hideTooltip() {
  if (tooltip === null) {
    return;
  }
  tooltip.remove();
  tooltip = null;
}

function showTooltip(container: Element) {
  if (!isEnabled()) {
    return;
  }
  hideTooltip();
  const content = createTooltip(container);
  if (content === undefined) {
    return;
  }
  document.body.appendChild(content);
  tooltip = content;
  positionTooltip(container, content);
}

function init() {
  subscribe($$(document, C.ColoredIcon.container), container => {
    // The stream may re-deliver a node after a DOM mutation.
    if (container.hasAttribute('data-rp-price-tooltip')) {
      return;
    }
    container.setAttribute('data-rp-price-tooltip', '');
    container.addEventListener('mouseenter', () => showTooltip(container));
    container.addEventListener('mouseleave', hideTooltip);
    container.addEventListener('mousedown', hideTooltip);
  });
  watch(
    () => userData.settings.pricing.materialPriceTooltips,
    enabled => {
      if (enabled !== true) {
        hideTooltip();
      }
    },
  );
  window.addEventListener('scroll', hideTooltip, true);
}

// 唯一开关在 XIT SET → 财务 → 价格设置，功能列表里不再重复出现。
features.add(import.meta.url, init, '物料图标悬浮显示各交易所实时买卖价。', true);
