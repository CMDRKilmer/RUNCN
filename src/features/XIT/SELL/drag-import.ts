// 仓库框选 → 拖入 XIT SELL 的桥接：
// 游戏自身拖拽的 dataTransfer 内容不可依赖，因此在 dragstart 时同步读取
// 所有带 selected 类的 GridItemView 物品（框选结果），写入自定义 mime 类型
// 与模块缓存，drop 时由 SELL 面板消费。不干扰游戏自身的拖拽数据。

let draggedTickers: string[] = [];

function onDragStart(event: DragEvent) {
  const target = event.target as Element | null;
  if (!target?.closest(`.${C.GridItemView.container}`)) {
    return;
  }
  const tickers = _$$(document, C.GridItemView.selected)
    .map(x => _$(x, C.ColoredIcon.label)?.textContent?.trim().toUpperCase())
    .filter((x): x is string => !!x);
  if (tickers.length === 0) {
    return;
  }
  draggedTickers = [...new Set(tickers)];
  try {
    event.dataTransfer?.setData('text/xit-sell', draggedTickers.join(','));
  } catch {
    // 部分浏览器/场景下 setData 受限，模块缓存兜底。
  }
}

export function consumeDraggedTickers() {
  const tickers = draggedTickers;
  draggedTickers = [];
  return tickers;
}

export function initDragImport() {
  document.addEventListener('dragstart', onDragStart);
}
