import $style from './rprun-version-label.module.css';
import { balancesStore } from '@src/infrastructure/prun-api/data/balances';
import { fixed0 } from '@src/utils/format';

const currencyOrder = ['NCC', 'AIC', 'CIS', 'ICA', 'ECD'];

async function onFooterReady(footer: HTMLElement) {
  const userCount = await $(footer, C.UsersOnlineCount.container);

  const balances = computed(() => {
    const all = balancesStore.all.value;
    if (all === undefined) {
      return [];
    }
    return all
      .filter(x => x.amount !== 0)
      .sort((a, b) => currencyOrder.indexOf(a.currency) - currencyOrder.indexOf(b.currency));
  });

  function onClick() {
    window.open('https://qm.qq.com/q/G8Gq8NmPym', '_blank');
  }

  createFragmentApp(() => (
    <>
      <div class={'rprun-cash-balances'} style={{ display: 'inline-flex', gap: '10px' }}>
        {balances.value.map(x => (
          <div class={[C.fonts.fontRegular, C.type.typeRegular]} style={{ color: '#fff' }}>
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
