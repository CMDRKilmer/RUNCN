import { refTextContent } from '@src/utils/reactive-dom';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import { PrunI18N } from '@src/infrastructure/prun-ui/i18n';

function onTileReady(tile: PrunTile) {
  const withdraw = PrunI18N['AdminCenter.upcoming.action.withdrawVote']?.[0]?.value;
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
