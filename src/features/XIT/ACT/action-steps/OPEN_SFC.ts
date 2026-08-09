import { act } from '@src/features/XIT/ACT/act-registry';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { focusElement, changeInputValue, clickElement } from '@src/util';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';
import { getPlanetName } from '@src/core/planet-name';
import { convertToPlanetNaturalId } from '@src/core/planet-natural-id';

interface Data {
  shipId: string;
  destination?: string;
}

export const OPEN_SFC = act.addActionStep<Data>({
  type: 'OPEN_SFC',
  description: data => {
    const ship = shipsStore.getById(data.shipId);
    const shipLabel = ship?.name ?? ship?.registration ?? 'unknown ship';
    return data.destination
      ? `Open SFC for ${shipLabel}, set destination to ${getPlanetName(data.destination)}`
      : `Open SFC for ${shipLabel}`;
  },
  execute: async ctx => {
    const { data, log, waitAct, requestTile, complete } = ctx;
    const assert: AssertFn = ctx.assert;

    const ship = shipsStore.getById(data.shipId);
    assert(ship, 'Ship not found');

    const tile = await requestTile(`SFC ${ship.registration}`);
    if (!tile) {
      return;
    }

    const destinationName = data.destination ? getPlanetName(data.destination) : undefined;

    if (data.destination) {
      const input = _$$(document.documentElement, C.AddressSelector.input)[0] as
        HTMLInputElement | undefined;
      if (!input) {
        log.warning('SFC address input not found — set destination manually');
        complete();
        return;
      }

      await waitAct(`Set destination to ${destinationName}?`);
      focusElement(input);
      changeInputValue(input, convertToPlanetNaturalId(data.destination) ?? data.destination);

      await waitAct('Select destination?');
      const portal = document.getElementById('autosuggest-portal');
      const suggestion = _$$(portal!, C.AddressSelector.suggestionContent)[0] as
        HTMLElement | undefined;
      if (suggestion) {
        await clickElement(suggestion);
        log.info(`Destination set: ${destinationName}`);
      } else {
        log.warning(`No suggestion found for ${destinationName} — select manually`);
      }
    }

    // Resize the companion window by directly setting Window.body dimensions.
    // UI_WINDOWS_UPDATE_SIZE doesn't work for docked tiles; direct style
    // manipulation on Window.body is the reliable approach for split windows.
    const windowEl = tile.frame.closest(`.${C.Window.window}`) as HTMLElement | null;
    const bodyEl = windowEl ? (_$(windowEl, C.Window.body) as HTMLElement | null) : null;
    if (bodyEl) {
      bodyEl.style.width = '975px';
      bodyEl.style.height = '750px';
    }
    if (data.destination) {
      // Reminder pause: keep ACT grayed so the player submits the flight first.
      await waitAct(`Submit flight to ${destinationName} in SFC, then continue`, {
        actDelayMs: 2000,
      });
    }
    complete();
  },
});
