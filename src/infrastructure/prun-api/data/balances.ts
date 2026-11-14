import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { createEntityStore } from '@src/infrastructure/prun-api/data/create-entity-store';
import { context } from '@src/infrastructure/prun-api/data/screens';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';

interface Payload {
  ownCurrency: PrunApi.Currency;
  currencyAccounts: PrunApi.CurrencyAccount[];
}

const store = createEntityStore<PrunApi.CurrencyAmount>({ selectId: x => x.currency });
const state = store.state;
const ownCurrency = ref('');

// 上一次在**公司上下文**看到的现金余额快照，写进 localStorage 供下次直接以
// 政府管理视图进游戏时兜底（政府视图里服务器根本不下发公司会计数据）。
// 按公司 ID 分键：同一浏览器切换账号后，不会把上一个账号的余额误显示成当前账号的。
const SNAPSHOT_PREFIX = 'rprun-cash-snapshot-';

interface Snapshot {
  // 记录时间（毫秒时间戳），用来告诉玩家这份是"上次同步"的数字。
  at: number;
  amounts: PrunApi.CurrencyAmount[];
}

function readSnapshot(companyId?: string): Snapshot | undefined {
  if (!companyId) {
    return undefined;
  }
  try {
    const raw = localStorage.getItem(SNAPSHOT_PREFIX + companyId);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Snapshot;
    return Array.isArray(parsed?.amounts) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const snapshot = ref<Snapshot | undefined>(undefined);

function writeSnapshot(companyId: string | undefined, amounts: PrunApi.CurrencyAmount[]) {
  if (!companyId) {
    return;
  }
  const next: Snapshot = { at: Date.now(), amounts };
  snapshot.value = next;
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + companyId, JSON.stringify(next));
  } catch {
    // 隐私模式 / 配额满：快照只是兜底，写不进去不影响实时数据显示。
  }
}

// 确认公司身份后再把快照暴露给界面：切换账号 / 进入政府视图但还没拿到公司信息时，
// 不显示上一份（可能是别的账号）的余额，避免政府视图误报上一个账号的数字
// （PR #60 审查 #225）。
watch(
  companyContextId,
  id => {
    snapshot.value = readSnapshot(id);
  },
  { immediate: true },
);

// 政府管理视图（URL 的 `context=` 是管理机构 id）里，服务器推的是**政府金库**的
// 会计数据：账户里通常只有 ICA 有余额（实测 ICA 6.3 万，NCC/AIC/CIS 全是 0）。
// 原实现无条件 setAll，会把公司的四种货币余额覆盖成政府那一份 —— 右下角余额因此
// 只剩 ICA，切回公司视图后还继续显示政府的数字，直到下次重新登录。
// 所以只在公司上下文（context 缺省或等于公司 id）接受现金余额，其它上下文一律
// 忽略；政府视图要显示公司余额时用 snapshot 兜底。
function isCompanyContext() {
  const urlContext = context.value;
  if (!urlContext || !companyContextId.value) {
    return true;
  }
  return urlContext === companyContextId.value;
}

onApiMessage({
  ACCOUNTING_CASH_BALANCES(data: Payload) {
    if (!isCompanyContext()) {
      return;
    }
    ownCurrency.value = data.ownCurrency.code;
    const amounts = data.currencyAccounts.map(x => x.currencyBalance);
    store.setAll(amounts);
    store.setFetched();
    writeSnapshot(companyContextId.value, amounts);
  },
  ACCOUNTING_BOOKINGS(data: { items: PrunApi.BookingItem[] }) {
    if (!isCompanyContext()) {
      return;
    }
    for (const item of data.items) {
      if (item.accountCategory !== 'LIQUID_ASSETS' && item.accountType !== 1800) {
        continue;
      }

      store.setOne(item.balance);
    }
  },
});

export const balancesStore = {
  ...state,
  ownCurrency,
  // 公司上下文最后一次的余额快照；政府视图里用它撑住右下角的四个数字。
  snapshot,
};
