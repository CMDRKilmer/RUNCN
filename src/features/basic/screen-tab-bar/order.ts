// 拖拽后的可见标签顺序 → 持久化顺序表。
//
// `userData.tabs.order` 只追加不删除（见 sync.ts），已被删除的屏幕 ID 会留在表里；
// 而标签栏渲染的是按 store 过滤后的列表。把 Sortable 上报的 DOM 索引直接套到
// 完整表上会错位：例如 `[deleted, A, B]`，把可见的 B 拖到 A 前面，按索引移动
// 实际上动的是保存的 A，可见顺序不变（PR #60 审查）。
//
// 这里按 screen id 对账：只重排「仍在的屏幕」所占的槽位，已删除的 ID 原位不动。
// `isPresent` 由调用方给出当前 store 里是否还有这个屏幕。
export function reconcileTabOrder(
  before: readonly string[],
  visibleAfter: readonly string[],
  isPresent: (id: string) => boolean,
): string[] {
  const present = new Set(before.filter(isPresent));
  const reordered: string[] = [];
  for (const id of visibleAfter) {
    if (present.has(id) && !reordered.includes(id)) {
      reordered.push(id);
    }
  }
  // 拖拽结果里漏掉的、仍在的屏幕（列表刷新慢一拍等）按原顺序补回，
  // 避免把标签弄丢；重复项和已不属于当前清单的 ID 一律忽略。
  for (const id of present) {
    if (!reordered.includes(id)) {
      reordered.push(id);
    }
  }
  let i = 0;
  return before.map(id => (present.has(id) ? reordered[i++] : id));
}
