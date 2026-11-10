import ContextControlsItem from '@src/components/ContextControlsItem.vue';
import { getInvStore } from '@src/core/store-id';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { EXCHANGE_CODES } from '@src/features/XIT/NX/nx-utils';
import { mountOnce } from '@src/utils/mount-ui-once';

/**
 * 判断当前 INV 是否为四大交易所空间站（ANT / BEN / HRT / MOR）的 CX 仓库。
 *
 * 仓库 id / storeId 一律从服务器推送的 store 运行时推导，禁止硬编码账号数据：
 *   INV <内部 id>  → storagesStore 前缀匹配 → 与四大站 warehouse.storeId 比对
 *   INV <站点名>   → 站点地址 naturalId 比对
 * 这保证换账号、换仓库后仍然自动生效，且和 XIT NX 面板管理的四个站点完全一致。
 */
function exchangeStationOf(parameter: string | null | undefined): string | undefined {
  if (!parameter) {
    return undefined;
  }
  const store = getInvStore(parameter);
  if (!store || !warehousesStore.fetched.value) {
    return undefined;
  }

  const byStoreId = EXCHANGE_CODES.find(
    code => warehousesStore.getByEntityNaturalId(code)?.storeId === store.id,
  );
  if (byStoreId) {
    return byStoreId;
  }

  const site = sitesStore.getById(store.addressableId);
  const naturalId = getEntityNaturalIdFromAddress(site?.address);
  return naturalId && EXCHANGE_CODES.includes(naturalId) ? naturalId : undefined;
}

async function onTileReady(tile: PrunTile) {
  const contextBar = await $(tile.frame, C.ContextControls.container);

  // 同一上下文栏只挂一次。仓库数据可能晚于磁贴到达，所以判定放在 computed 里：
  // 数据就绪后渲染函数自动补出按钮，不需要重新等待磁贴事件。
  // 用 appendTo 而不是 prependTo，避免改变已有的「隐藏控件 / WAR」等项目顺序。
  mountOnce(contextBar, 'inv-nx-buy-fuel', () => {
    const station = computed(() => exchangeStationOf(tile.parameter));
    createFragmentApp(() =>
      station.value ? <ContextControlsItem cmd="XIT NX" display="快捷买油" /> : null,
    ).appendTo(contextBar);
  });
}

function init() {
  tiles.observe('INV', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'INV：四大交易所 CX 仓库的上下文栏添加外显为「快捷买油」的入口（点击打开 XIT NX），外观沿用原生上下文命令，不显示 XIT NX 命令字样。',
);
