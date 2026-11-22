import { getMaterialByName } from '@src/infrastructure/prun-ui/i18n';

// RTE 航线执行明细里，把「物料名，N单位」改写成「TICKER×N」（如「水，32单位」→「H2O×32」）。
// 只改屏幕上显示的文字（DOM 文本节点），不触碰游戏内部数据：RTE 的装载/卸船动作由
// 游戏自己的执行数据驱动，本功能既不影响计算也不影响自动装卸。刷新页面即恢复原文。

// 匹配「<物料名>，<数字(可含千分位)>单位」，排除「从本地仓储加注至…，最大容量」这类说明。
const SUMMARY_RE = /^(.+)，([\d,]+)单位$/;

function abbreviate(summary: HTMLElement) {
  const text = summary.textContent;
  if (!text) {
    return;
  }
  const match = SUMMARY_RE.exec(text);
  if (!match) {
    return;
  }
  const [, name, amount] = match;
  const material = getMaterialByName(name);
  if (!material?.ticker) {
    // 物料名映射尚未就绪时保持原文，等 i18n / store 加载后由后续 observer 再试。
    return;
  }
  // ticker 后直接跟乘号，不补空格：「ROM×38」。
  const newText = `${material.ticker}×${amount}`;
  if (text === newText) {
    return;
  }
  // 只改文本节点，保留节点引用；React 重渲染时由 observer 再缩写。
  for (const node of Array.from(summary.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent) {
      continue;
    }
    if (SUMMARY_RE.test(node.textContent)) {
      node.textContent = node.textContent.replace(SUMMARY_RE, () => newText);
    }
  }
}

function abbreviateAll(tile: PrunTile) {
  tile.anchor.querySelectorAll<HTMLElement>('[class*="Step__summary"]').forEach(abbreviate);
}

function onTileReady(tile: PrunTile) {
  abbreviateAll(tile);
  // Step__summary 文本会随执行进度变化，且 RTE 明细是滚动/增量渲染的。
  // 监听 anchor 子树的节点增改与文本内容变更，新增或重绘的步骤行都再缩写一次。
  // 自己做缩写时会改动文本节点，但改完的内容不再匹配 SUMMARY_RE，故不会无限循环。
  const observer = new MutationObserver(() => abbreviateAll(tile));
  observer.observe(tile.anchor, { childList: true, subtree: true, characterData: true });
}

function init() {
  tiles.observe('RTE', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'RTE：明细物料名称显示为英文代码（如「水，32单位」→「H2O×32」）。',
);
