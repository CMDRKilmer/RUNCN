import { hasMountedUi } from '@src/utils/mount-ui-once';
import BraRepairByType from './bra-repair-by-type.vue';

// BRA（维修助手）面板本身只支持「按状况阈值一次修完所有建筑」，
// 分类批量维修的界面放在 BRA 里：工具条插在「待维护建筑」那一行之前。
function onTileReady(tile: PrunTile) {
  const siteId = tile.parameter;
  if (!siteId) {
    return;
  }
  subscribe($$(tile.anchor, C.BuildingRepairAssistantPanel.buildingList), list => {
    // 「待维护建筑」整块是 React 渲染的，容器重渲染会带走插入的节点，
    // 所以每次重建都重新挂一次；hasMountedUi 防止重复挂。
    const container = list.closest(`.${C.FormComponent.containerPassive}`);
    const host = container?.parentElement;
    if (!container || !host || hasMountedUi(host, 'bra-repair-by-type')) {
      return;
    }
    createFragmentApp(BraRepairByType, { siteId, root: tile.anchor }).before(container);
  });
}

function init() {
  tiles.observe('BRA', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'BRA：加「按类型维修」工具条，点一类即批量修同类（本开关控制其显隐）。',
);
