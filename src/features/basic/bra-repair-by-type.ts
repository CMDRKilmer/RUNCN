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
  'BRA：在「待维护建筑」上方加「按类型维修」工具条，建筑名统一用游戏原生缩写（如软件开发部门显示 SD）。本功能同时是该工具条的显隐开关，默认开启；关闭后工具条不再显示。点某一类可一次修完同类型所有建筑（逐栋走游戏原生维修按钮，需连点两次确认）。',
);
