// 基地别名：在 BS 面板添加「别名」按钮，点击弹出编辑弹窗。
//
// 数据存储在 userData.baseAliases，按 siteId 索引。
// 别名查找核心逻辑放在 core/base-aliases.ts，便于 SFC 输入框替换等功能复用。
// 面板标题旁的别名显示由 base-alias-display feature 统一处理。

import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { setBaseAlias, clearBaseAlias, getBaseAlias } from '@src/core/base-aliases';
import EditAliasOverlay from './EditAliasOverlay.vue';
import PrunButton from '@src/components/PrunButton.vue';

function findSiteByTileParameter(parameter: string | undefined) {
  if (!parameter) {
    return undefined;
  }
  return (
    sitesStore.getByPlanetNaturalId(parameter) ??
    sitesStore.getByPlanetName(parameter) ??
    sitesStore.getByPlanetNaturalIdOrName(parameter)
  );
}

function onEditClick(tile: PrunTile, siteId: string, targetLabel: string, currentAlias: string) {
  showTileOverlay(tile.anchor, EditAliasOverlay, {
    currentAlias,
    targetLabel,
    onSave: alias => setBaseAlias(siteId, alias),
    onClear: () => clearBaseAlias(siteId),
  });
}

function onTileReady(tile: PrunTile) {
  if (!tile.parameter) {
    return;
  }

  const site = findSiteByTileParameter(tile.parameter);
  if (!site) {
    return;
  }
  const siteId = site.siteId;
  const naturalId = getEntityNaturalIdFromAddress(site.address) ?? tile.parameter;
  const planetName = getEntityNameFromAddress(site.address) ?? naturalId;
  const targetLabel = `${planetName}（${naturalId}）`;

  // ActionBar：添加「别名」按钮。
  subscribe($$(tile.anchor, C.ActionBar.container), container => {
    createFragmentApp(() => (
      <div class={C.ActionBar.element}>
        <PrunButton
          primary
          onClick={() => onEditClick(tile, siteId, targetLabel, getBaseAlias(siteId) ?? '')}>
          别名
        </PrunButton>
      </div>
    )).appendTo(container);
  });
}

function init() {
  tiles.observe('BS', onTileReady);
}

features.add(import.meta.url, init, 'BS：添加基地别名编辑按钮。');
