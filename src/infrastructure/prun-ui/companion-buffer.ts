import { $ } from '@src/utils/select-dom';
import { setBufferSize } from '@src/infrastructure/prun-ui/buffers';
import { clickElement, changeInputValue } from '@src/util';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { UI_TILES_CHANGE_COMMAND } from '@src/infrastructure/prun-api/client-messages';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';

export async function openCompanionBuffer(tile: PrunTile, command: string) {
  const windowEl = tile.frame.closest(`.${C.Window.window}`) as HTMLElement | null;

  if (tile.container.classList.contains(C.Window.body)) {
    const parsedW = parseInt(tile.container.style.width, 10);
    const parsedH = parseInt(tile.container.style.height, 10);
    const w = Number.isNaN(parsedW) ? 600 : parsedW;
    const h = Number.isNaN(parsedH) ? 400 : parsedH;
    setBufferSize(tile.id, w + 450, h);

    const splitButton = _$$(tile.frame, C.TileControls.control).find(x => x.textContent === '|');
    await clickElement(splitButton);

    if (!windowEl) {
      return;
    }

    const node = await $(windowEl, C.Node.node);
    const companion = _$$(node, C.Node.child)[1] as HTMLElement | undefined;
    if (companion) {
      await setChildCommand(companion, command);
    }
  } else if (tile.container.classList.contains(C.Node.child)) {
    const node = tile.container.parentElement!;
    const sibling = _$$(node, C.Node.child).find(x => x !== tile.container);
    if (sibling) {
      await setChildCommand(sibling, command);
    }
  }
}

async function setChildCommand(child: Element, command: string) {
  const tileEl = _$(child, C.Tile.tile) as HTMLElement | null;
  const id = tileEl !== null ? getPrunId(tileEl) : null;
  if (id !== null && dispatchClientPrunMessage(UI_TILES_CHANGE_COMMAND(id, command))) {
    return;
  }
  const input = (await $(child, C.PanelSelector.input)) as HTMLInputElement;
  changeInputValue(input, command);
  input.form!.requestSubmit();
}
