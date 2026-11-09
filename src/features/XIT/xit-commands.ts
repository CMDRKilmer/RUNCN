import ContextControls from '@src/components/ContextControls.vue';
import { tileStatePlugin } from '@src/store/user-data-tiles';
import { startMeasure, stopMeasure } from '@src/utils/performance-measure';
import { isEmpty } from 'ts-extras';
import { xitParametersKey } from '@src/hooks/use-xit-parameters';
import { xitCommandKey } from '@src/hooks/use-xit-command';
import { userData } from '@src/store/user-data';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { tileKey } from '@src/hooks/use-tile';

function onTileReady(tile: PrunTile) {
  let rawParameter = tile.parameter;
  if (!rawParameter) {
    rawParameter = 'CMDS';
  }

  let parameters = [] as string[];
  if (rawParameter[0] === '1') {
    const keyValues = rawParameter.split(' ');
    parameters.push(...keyValues.map(x => x.slice(2)));
  } else {
    parameters = rawParameter.split(/[_ ]+/g);
  }
  if (isEmpty(parameters)) {
    return;
  }

  const command = parameters[0];
  if (command.toUpperCase() == 'FIO' || command.toUpperCase() == 'COL') {
    // FIO 和 PrUn-Collector 使用 XIT 的例外情况
    return;
  }
  const xitCommand = xit.get(command);
  parameters = parameters.slice(1);

  if (xitCommand) {
    _$(tile.frame, C.TileFrame.title)!.textContent =
      typeof xitCommand.name === 'string' ? xitCommand.name : xitCommand.name(parameters);

    if (xitCommand.contextItems) {
      const items = xitCommand.contextItems(parameters);
      if (!isEmpty(items)) {
        const header = _$(tile.frame, C.TileFrame.header)!;
        createFragmentApp(ContextControls, { items }).after(header);
      }
    }
  }

  subscribe($$(tile.anchor, C.ScrollView.view), scrollView => {
    // 别的功能可能把整块磁贴嵌进自己的面板里（例如 FB 把 BS/INV/PROD 搬进同一块磁贴）。
    // 这种嵌套磁贴的滚动区不属于当前磁贴，跳过，否则会在每个嵌套磁贴里再挂一份本命令。
    const owner = scrollView.closest(`.${C.Tile.tile}`);
    if (owner && owner !== tile.frame.parentElement) {
      return;
    }
    // XIT 命令生成一个包含全尺寸绿色屏幕的磁贴。
    // 自定义 XIT 磁贴就是挂载在这个绿色屏幕内部的。
    const container = scrollView.children[0] as HTMLDivElement;
    if (container === undefined) {
      return;
    }

    container.removeAttribute('style');
    container.style.width = '100%';
    container.style.height = '100%';

    if (!xitCommand) {
      container.textContent = '错误！没有匹配的功能！';
      return;
    }

    startMeasure(tile.fullCommand);
    createFragmentApp(xitCommand.component(parameters))
      .use(tileStatePlugin, { tile })
      .provide(tileKey, tile)
      .provide(xitCommandKey, command)
      .provide(xitParametersKey, parameters)
      .appendTo(container);
    stopMeasure();
  });
}

export function initializeXitCommands() {
  tiles.observe('XIT', onTileReady);
  if (userData.settings.mode === undefined) {
    setTimeout(() => showBuffer('XIT START'), 1000);
  }
}
