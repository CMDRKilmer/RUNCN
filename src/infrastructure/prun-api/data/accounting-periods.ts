import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { sendServerMessage } from '../socket-io-middleware';
import { companyContextId } from './user-data';
import { context } from './screens';

// 游戏下发的会计期间余额（ACCOUNTING_BALANCES）。
//
// 每条 period 里的 accounts[] 就是该期期末各科目余额；其中**收入/支出类科目
// 的余额本身就是当期发生额**（每期结转到利润），所以利润表直接读它们即可，
// 不需要再对 bookings 做差。
interface Account {
  category: string;
  type: number;
  number: number;
  bookBalance: PrunApi.CurrencyAmount;
  currencyBalance: PrunApi.CurrencyAmount;
}

interface Period {
  period: number;
  accounts: Account[];
}

const periods = ref<Period[]>([]);

// 政府管理视图（URL 的 `context=` 是管理机构 id）里，服务器推的是**政府**的会计数据。
// 判断与 balancesStore 保持一致：只在公司上下文接受。否则政府的收入/支出会留在这里，
// 切回公司后利润表显示的还是政府那份，而且页面因为「已有数据」不再请求，等于卡死。
function isCompanyContext() {
  const urlContext = context.value;
  if (!urlContext || !companyContextId.value) {
    return true;
  }
  return urlContext === companyContextId.value;
}

onApiMessage({
  ACCOUNTING_BALANCES(data: { periods?: Period[] }) {
    if (!isCompanyContext()) {
      return;
    }
    if (Array.isArray(data?.periods) && data.periods.length > 0) {
      periods.value = data.periods;
    }
  },
});

// 静默拉取：会计期间余额平时是游戏客户端在打开原生 FIN / FINIS 时向服务器要的，
// 插件自己的页面在用户没开过原生窗口时收不到这条消息（表现为「打开一次 FIN 后
// 回来才有数据」）。这里复用游戏 socket 主动要一次——只读请求、不改服务端状态，
// 响应仍走上面的 onApiMessage 统一处理。
//
// 按 contextId 记账而不是用一次性布尔值：换公司 / 重新登录后还要再要一次。
// force=true（面板上的「刷新数据」）绕过这条记录，用于本期数据已经变化、
// 需要重新取一次快照的场景。
let requestedFor: string | undefined;

export function requestAccountingPeriods(force = false) {
  const id = companyContextId.value;
  if (id === undefined || !isCompanyContext()) {
    return;
  }
  if (!force && requestedFor === id) {
    return;
  }
  const sent = sendServerMessage({
    messageType: 'ACCOUNTING_GET_BALANCES',
    payload: {},
    actionId: crypto.randomUUID(),
    contextId: id,
  });
  if (sent) {
    requestedFor = id;
  }
}

/** 页面挂载时调用：没数据就补一次请求。 */
export function ensureAccountingPeriods() {
  if (periods.value.length === 0) {
    requestAccountingPeriods();
  }
}

// 拿到公司身份后先预热一次：socket 可能比 userData 晚就绪，隔几秒补发。
// 这一步是**有意的**：用户已确认保留自动拉取（否则固定窗口要手动点刷新才出数）。
// 只在公司上下文里发，且整个上下文只发一次（requestedFor 记账）。
watch(
  companyContextId,
  id => {
    if (id === undefined) {
      return;
    }
    setTimeout(ensureAccountingPeriods, 3000);
  },
  { immediate: true },
);

export const accountingPeriods = {
  /** 按期间升序（末尾是当前期） */
  all: computed(() => periods.value),
  /** 最近 n 期，按时间正序 */
  recent(n: number) {
    return periods.value.slice(-n);
  },
};
