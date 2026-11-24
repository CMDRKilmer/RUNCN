import { getMaterialByName } from '@src/infrastructure/prun-ui/i18n';
import onNodeDisconnected from '@src/utils/on-node-disconnected';

// RTE 航线执行明细里，把「物料名，N单位」改写成「TICKER×N」（如「水，32单位」→「H2O×32」）。
// 只改屏幕上显示的文字（DOM 文本节点），不触碰游戏内部数据：RTE 的装载/卸船动作由
// 游戏自己的执行数据驱动，本功能既不影响计算也不影响自动装卸。刷新页面即恢复原文。

// 匹配「<物料名>，<数字(可含千分位)>单位」，排除「从本地仓储加注至…，最大容量」这类说明。
// 千分位分隔符随界面语言走：zh/en 是 ","、de 是 "."、fr 是空格（普通/NBSP/窄 NBSP）、
// 部分语言是 "'"。只认逗号会让 `水，1.000单位`、`水，1 000单位` 这类本地化数量匹配失败，
// 那些步骤就保持原文不缩写。数量本身是整数，这些分隔符统统接受，捕获时原样保留。
// 物料名与数量之间的逗号同样可能被本地化成半角，这里两种都认。
// 名字用懒惰匹配：数量里允许出现 "," "."，贪婪匹配会把 `水，1,000单位` 拆成
// 名字「水，1」+ 数量「000」，反过来匹配不到物料名而整行不缩写。
const SUMMARY_RE = /^(.+?)[，,]\s*(\d[\d.,'’\u00A0\u2009\u202F ]*)\s*单位$/;

function abbreviate(summary: HTMLElement) {
  const text = summary.textContent;
  if (!text) {
    return;
  }
  const match = SUMMARY_RE.exec(text);
  if (!match) {
    return;
  }
  // 数量两侧可能有 NBSP 之类的空白（`1,000 单位`），去掉尾部空白，别把空格带进缩写。
  const [, name, rawAmount] = match;
  const amount = rawAmount.trim();
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

// 每个 anchor 当前的观察器。同一磁贴重复激活时先断开旧的，保证始终只有一个在跑。
const observers = new WeakMap<HTMLElement, MutationObserver>();

function onTileReady(tile: PrunTile) {
  abbreviateAll(tile);
  observers.get(tile.anchor)?.disconnect();
  // Step__summary 文本会随执行进度变化，且 RTE 明细是滚动/增量渲染的。
  // 监听 anchor 子树的节点增改与文本内容变更，新增或重绘的步骤行都再缩写一次。
  // 自己做缩写时会改动文本节点，但改完的内容不再匹配 SUMMARY_RE，故不会无限循环。
  const observer = new MutationObserver(() => abbreviateAll(tile));
  observer.observe(tile.anchor, { childList: true, subtree: true, characterData: true });
  observers.set(tile.anchor, observer);
  // 切标签页 / 移动 FB 时 React 会保留 frame、断连后再挂回，并在重新激活时再次调用
  // 本回调。不在这里断开，每次重激活都会多留一个活动观察器，长会话里文本一变就要
  // 重复扫描多遍。与 RT 功能一致，绑定到 frame 的断开事件上。
  onNodeDisconnected(tile.frame, () => {
    observer.disconnect();
    if (observers.get(tile.anchor) === observer) {
      observers.delete(tile.anchor);
    }
  });
}

function init() {
  tiles.observe('RTE', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'RTE：明细物料名称显示为英文代码（如「水，32单位」→「H2O×32」）。',
);
