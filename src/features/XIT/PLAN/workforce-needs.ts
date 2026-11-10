// FIO 人口消耗品数据接口与存储。
// 数据来源：https://rest.fnar.net/global/workforceneeds
// Amount 单位：每100人/天。

interface WorkforceNeedItem {
  MaterialTicker: string;
  Amount: number;
}

export interface WorkforceNeed {
  WorkforceType: string;
  Needs: WorkforceNeedItem[];
}

export const workforceNeedsStore = shallowReactive<{
  needs: WorkforceNeed[] | undefined;
  fetched: boolean;
  loading: boolean;
}>({
  needs: undefined,
  fetched: false,
  loading: false,
});

export async function loadWorkforceNeeds() {
  if (workforceNeedsStore.loading || workforceNeedsStore.fetched) {
    return;
  }
  workforceNeedsStore.loading = true;
  try {
    const resp = await fetch('https://rest.fnar.net/global/workforceneeds');
    if (!resp.ok) {
      return;
    }
    workforceNeedsStore.needs = (await resp.json()) as WorkforceNeed[];
    workforceNeedsStore.fetched = true;
  } catch {
    // 保留未加载状态，调用方可重试。
  } finally {
    workforceNeedsStore.loading = false;
  }
}
