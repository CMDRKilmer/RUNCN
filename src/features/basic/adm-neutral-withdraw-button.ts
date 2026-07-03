import { refTextContent } from '@src/utils/reactive-dom';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

function onTileReady(tile: PrunTile) {
  const withdraw = getI18nValue('AdminCenter.upcoming.action.withdrawVote');
  if (!withdraw) {
    return;
  }
  subscribe($$(tile.anchor, C.UpcomingTerm.container), container => {
    subscribe($$(container, 'table'), table => {
      subscribe($$(table, C.Button.primary), button => {
        const text = refTextContent(button);
        watchEffectWhileNodeAlive(button, () => {
          if (text.value === withdraw) {
            button.classList.add(C.Button.neutral);
          } else {
            button.classList.remove(C.Button.neutral);
          }
        });
      });
    });
  });
}

function init() {
  tiles.observe('ADM', onTileReady);
}

features.add(import.meta.url, init, 'ADM：为"撤回"投票按钮应用中性样式。');
