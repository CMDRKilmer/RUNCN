import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fillAmount } from '@src/features/XIT/ACT/actions/cx-buy/utils';
import { changeInputValue, clickElement } from '@src/util';
import { fixed0, fixed02 } from '@src/utils/format';
import { sleep } from '@src/utils/sleep';
import { ref } from 'vue';

// 四大交易所空间站（naturalId）
export const EXCHANGE_CODES = ['ANT', 'BEN', 'HRT', 'MOR'];

export interface BuyResult {
  ok: boolean;
  msg: string;
}

// 每个交易所空间站的 CX 仓库（买油成交后存放处）。
// code 是空间站 naturalId（ANT/BEN/HRT/MOR），warehouse 的地址 naturalId 即空间站。
export function getCxStore(code: string) {
  const warehouse = warehousesStore.getByEntityNaturalId(code);
  return warehouse?.storeId ? storagesStore.getById(warehouse.storeId) : undefined;
}

// 空间站 naturalId → 交易所 code（如 ANT → AI1），CX 订单簿/CXPO 命令都用交易所 code。
export function getExchangeCode(station: string) {
  return exchangesStore.all.value?.find(ex => getEntityNaturalIdFromAddress(ex.address) === station)
    ?.code;
}

export function getAmountOf(store: PrunApi.Store | undefined, ticker: string) {
  return store?.items.find(x => x.quantity?.material.ticker === ticker)?.quantity?.amount ?? 0;
}

function poll<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const deadline = Date.now() + ms;
    const tick = async () => {
      const value = get();
      if (value !== undefined && value !== null) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        resolve(undefined);
        return;
      }
      await sleep(200);
      void tick();
    };
    void tick();
  });
}

// 在指定空间站交易所挂一张市价买单，成交后油进入该空间站的 CX 仓库
export async function buyFuel(code: string, ticker: string, amount: number): Promise<BuyResult> {
  const exchangeCode = getExchangeCode(code);
  if (!exchangeCode) {
    return { ok: false, msg: '交易所数据未加载' };
  }
  const cxTicker = `${ticker}.${exchangeCode}`;
  const closeWhen = ref(false);
  try {
    const win = await showBuffer(`CXPO ${cxTicker}`, { autoClose: true, closeWhen });
    if (win === undefined || win === null) {
      return { ok: false, msg: '无法打开 CXPO 面板' };
    }
    // 打开 CXPO 后订单簿数据（COMEX_BROKER_DATA）会推送，等待就绪后按市价计算
    const broker = await poll(() => cxobStore.getByTicker(cxTicker), 8000);
    if (!broker) {
      return { ok: false, msg: '订单簿数据加载超时' };
    }
    const filled = fillAmount(cxTicker, amount, Infinity);
    if (!filled || filled.amount <= 0) {
      return { ok: false, msg: '市场上没有可用的卖单' };
    }
    const form = await poll(() => _$(win, C.ComExPlaceOrderForm.form), 8000);
    if (!form) {
      return { ok: false, msg: '挂单表单未渲染' };
    }
    const inputs = await poll(() => {
      const list = _$$(form, 'input');
      return list.length >= 2
        ? [list[0] as HTMLInputElement, list[1] as HTMLInputElement]
        : undefined;
    }, 8000);
    if (!inputs) {
      return { ok: false, msg: '挂单输入框未就绪' };
    }
    const [quantityInput, priceInput] = inputs;
    // 按可成交数量填单：数量不足时按市场现有卖单量部分购买
    const buyAmount = Math.min(amount, filled.amount);
    changeInputValue(quantityInput, fixed0(buyAmount));
    changeInputValue(priceInput, fixed02(filled.priceLimit));
    await sleep(200);
    const buyButton = await poll(() => _$(win, C.Button.success), 5000);
    if (!buyButton) {
      return { ok: false, msg: '未找到买入按钮' };
    }
    clickElement(buyButton as HTMLElement);
    // 等待游戏返回成功/失败反馈
    const outcome = await Promise.race([
      $(win, C.ActionFeedback.error),
      $(win, C.ActionFeedback.success),
    ]);
    const ok = outcome?.classList.contains(C.ActionFeedback.success) === true;
    const partial = buyAmount < amount;
    return ok
      ? {
          ok: true,
          msg: partial ? `已购 ${fixed0(buyAmount)}/${fixed0(amount)}` : `已购 ${fixed0(amount)}`,
        }
      : { ok: false, msg: '买单被拒绝' };
  } finally {
    closeWhen.value = true;
  }
}
