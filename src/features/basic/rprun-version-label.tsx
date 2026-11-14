import $style from './rprun-version-label.module.css';
import { balancesStore } from '@src/infrastructure/prun-api/data/balances';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0 } from '@src/utils/format';

// PrUn 的四种常备货币；始终各占一格，缺数据按 0 显示。
// 固定四格的两个理由：
//   1. 政府管理视图里服务器只发政府金库的会计数据（只有 ICA 有钱），公司余额要
//      靠 balancesStore.snapshot 兜底 —— 否则右下角只剩 ICA 一个数字（玩家会以为
//      钱没了）。
//   2. 每一格要能点开对应货币的换汇面板，位置不能随余额变化而跳动。
const CURRENCIES = ['NCC', 'AIC', 'CIS', 'ICA'];
// ECD 是活动/特殊货币，有余额时才追加一格。
const EXTRA_CURRENCIES = ['ECD'];

function formatSnapshotTime(at: number) {
  const date = new Date(at);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 点余额开换汇：XIT 命令的真实写法是 `XIT <命令> <参数>`（游戏只认 XIT 这一个
// 命令，后面全是它的参数）。写成 `FX NCC` 会被游戏判为"无效指令"。
// 四种货币各有自己的命令串 → 各开各的窗口，互不覆盖；同一种货币重复点只聚焦那一块。
function openExchange(currency: string) {
  void showBuffer(`XIT FX ${currency}`);
}

async function onFooterReady(footer: HTMLElement) {
  const userCount = await $(footer, C.UsersOnlineCount.container);

  const rows = computed(() => {
    const live = balancesStore.all.value ?? [];
    const cached = balancesStore.snapshot.value;
    // 政府视图里实时余额是空的（公司会计数据不下发），退回到上次公司视图的快照。
    const usingSnapshot = live.length === 0 && (cached?.amounts.length ?? 0) > 0;
    const source = usingSnapshot ? cached!.amounts : live;
    const cells = CURRENCIES.map(currency => ({
      currency,
      amount: source.find(x => x.currency === currency)?.amount ?? 0,
    }));
    for (const currency of EXTRA_CURRENCIES) {
      const amount = source.find(x => x.currency === currency)?.amount ?? 0;
      if (amount !== 0) {
        cells.push({ currency, amount });
      }
    }
    return { cells, usingSnapshot, at: cached?.at };
  });

  function chipTooltip(currency: string) {
    const base = `点击打开 ${currency} 换汇`;
    const { usingSnapshot, at } = rows.value;
    if (!usingSnapshot || at === undefined) {
      return base;
    }
    return `${base}（余额为上次同步：${formatSnapshotTime(at)}）`;
  }

  function onClick() {
    window.open('https://qm.qq.com/q/G8Gq8NmPym', '_blank');
  }

  createFragmentApp(() => (
    <>
      <div class={'rprun-cash-balances'} style={{ display: 'inline-flex', gap: '10px' }}>
        {rows.value.cells.map(x => (
          <div
            class={[
              C.fonts.fontRegular,
              C.type.typeRegular,
              $style.chip,
              ...(x.amount === 0 ? [$style.zero] : []),
            ]}
            style={{ color: '#fff' }}
            title={chipTooltip(x.currency)}
            onClick={() => openExchange(x.currency)}>
            <div class={C.HeadItem.label}>
              {x.currency} {fixed0(x.amount)}
            </div>
          </div>
        ))}
      </div>
      <div
        class={[
          'rprun-version-label',
          $style.container,
          C.HeadItem.container,
          C.fonts.fontRegular,
          C.type.typeRegular,
        ]}
        data-tooltip="琉璃主权资本集团内部使用。本插件为内部版本，非组织成员使用会造成不可逆的损失，请自行珍重"
        data-tooltip-position="top"
        onClick={onClick}>
        <div class={[C.HeadItem.indicator, C.HeadItem.indicatorSuccess]} />
        <div class={[$style.label, C.HeadItem.label]}>v. {config.version} 琉璃制 FOXV</div>
      </div>
    </>
  )).before(userCount);
}

function init() {
  applyCssRule(`.${C.Frame.foot}`, $style.foot);
  subscribe($$(document, C.Frame.foot), onFooterReady);
}

features.add(import.meta.url, init, '在右下角添加"Refined PrUn 版本"标签与现金余额。');
