import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { context, screensStore } from '@src/infrastructure/prun-api/data/screens';
import { userData } from '@src/store/user-data';

// 标签顺序与隐藏清单是「用户数据」，不能被任何一次列表刷新反向对账掉。
// 历史实现是「不在当前可见清单里的 id 就删掉」，而清单会随上下文变化：
// 政府管理视图（URL 带 `context=<管理机构 id>`）的 UI_DATA 只带当前视图的屏幕
// （实测 1 条），于是切一次政府视图就把 order 和 hidden 逐条删空 —— 隐藏过的
// 标签全部复现。现在只做「把新出现的屏幕追加到末尾」，删除交给 UI_SCREENS_DELETE
// 自己走（屏幕没了，标签栏按 store 过滤自然不显示，无需在此清理）。
function isSyncableContext() {
  const urlContext = context.value;
  if (urlContext === undefined) {
    // 没有 `context` 参数就是普通公司视图。
    return true;
  }
  const company = companyContextId.value;
  // 带 context 但还不知道公司 id（USER_DATA 未到）：先跳过，等它到了
  // watchEffect 会再跑一次。
  return company !== undefined && urlContext === company;
}

export function syncState() {
  if (!isSyncableContext()) {
    return;
  }
  const sorted = screensStore.sorted.value;
  if (!sorted || sorted.length === 0) {
    return;
  }
  const order = userData.tabs.order;
  const tracked = new Set<string>([...order, ...userData.tabs.hidden]);
  for (const tab of sorted) {
    if (!tracked.has(tab.id)) {
      order.push(tab.id);
    }
  }
}
