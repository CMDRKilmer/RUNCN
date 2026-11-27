import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

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

export const accountingPeriods = {
  /** 按期间升序（末尾是当前期） */
  all: computed(() => periods.value),
  /** 最近 n 期，按时间正序 */
  recent(n: number) {
    return periods.value.slice(-n);
  },
};
