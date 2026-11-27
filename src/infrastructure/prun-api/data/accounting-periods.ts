import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { sendServerMessage } from '../socket-io-middleware';
import { companyContextId } from './user-data';

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

onApiMessage({
  ACCOUNTING_BALANCES(data: { periods?: Period[] }) {
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
// 同一会话只发一次：数据是整期余额，重复请求没有意义；失败（socket 未就绪）时
// 不置位，下次打开页面还可以再试。
let requested = false;

export function requestAccountingPeriods() {
  if (requested) {
    return;
  }
  const sent = sendServerMessage({
    messageType: 'ACCOUNTING_GET_BALANCES',
    payload: {},
    actionId: crypto.randomUUID(),
    contextId: companyContextId.value,
  });
  if (sent) {
    requested = true;
  }
}

/** 页面挂载时调用：没数据就补一次请求。 */
export function ensureAccountingPeriods() {
  if (periods.value.length === 0) {
    requestAccountingPeriods();
  }
}

// 拿到公司身份后先预热一次：socket 可能比 userData 晚就绪，隔几秒补发。
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
