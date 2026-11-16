import { getInvStore } from '@src/core/store-id';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

// 交易所仓库的 INV 里点物料图标，原生会打开 `MAT <ticker>`。这里改成打开该物料
// 在本交易所的交易界面 `CXPO <ticker>.<exchange>`，省掉再输交易所代码。
// 只处理交易所仓库（WAREHOUSE_STORE）：基地 / 船只仓库没有唯一所属交易所，不碰。
// 交易所代码全部由服务器推送的 store 推导，不硬编码仓库 id 或交易所代码。
const TICKER_PREFIX = 'rp-ticker-';

function getExchangeCode(parameter?: string | null) {
  const store = getInvStore(parameter);
  if (store?.type !== 'WAREHOUSE_STORE') {
    return undefined;
  }
  const warehouse = warehousesStore.getById(store.addressableId);
  const naturalId = getEntityNaturalIdFromAddress(warehouse?.address);
  return exchangesStore.getByNaturalId(naturalId)?.code;
}

function onTileReady(tile: PrunTile) {
  const code = getExchangeCode(tile.parameter);
  if (!code) {
    return;
  }

  // capture 阶段拦截，抢在原生 onClick 之前。React 重渲染会替换图标节点，
  // 所以监听挂在稳定的 frame 上，用事件委托命中当前图标。
  tile.frame.addEventListener(
    'click',
    event => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const icon = target.closest(`.${C.ColoredIcon.container}`);
      if (!icon) {
        return;
      }
      const tickerClass = Array.from(icon.classList).find(x => x.startsWith(TICKER_PREFIX));
      if (!tickerClass) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void showBuffer(`CXPO ${tickerClass.slice(TICKER_PREFIX.length)}.${code}`);
    },
    true,
  );
}

function init() {
  tiles.observe('INV', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'INV：交易所仓库内点击物料图标，改为打开该物料在对应交易所的交易界面。',
);
