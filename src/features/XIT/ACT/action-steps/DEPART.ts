import { act } from '@src/features/XIT/ACT/act-registry';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';
import { clickElement } from '@src/util';
import { sleep } from '@src/utils/sleep';

interface Data {
  registration: string;
}

// 「开始」按钮就绪的超时（毫秒）。
const BUTTON_TIMEOUT = 15_000;

function poll<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const deadline = Date.now() + ms;
    const tick = async () => {
      const value = get();
      if (value !== undefined && value !== null) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        resolve(undefined);
        return;
      }
      await sleep(200);
      void tick();
    };
    void tick();
  });
}

// 等 SFC 指令表单的「开始」按钮渲染并启用（目的地+燃料计算就绪后才会启用）。
function waitForStartButton(tile: PrunTile) {
  return poll(() => {
    const command = _$(tile.anchor, C.FormComponent.containerCommand);
    const button = command ? _$(command, C.Button.success) : undefined;
    if (!button || button.classList.contains(C.Button.disabled)) {
      return undefined;
    }
    return button as HTMLElement;
  }, BUTTON_TIMEOUT);
}

export const DEPART = act.addActionStep<Data>({
  type: 'DEPART',
  description: data => `自动出发 ${data.registration}`,
  execute: async ctx => {
    const { data, log, setStatus, complete, fail } = ctx;
    const assert: AssertFn = ctx.assert;
    const { registration } = data;

    setStatus(`正在为 ${registration} 自动出发...`);
    // 前一步 OPEN SFC 已打开该飞船的航行控制面板。
    const tile = tiles.find(`SFC ${registration}`, true).at(0);
    assert(tile, `未找到 ${registration} 的航行控制面板`);

    const button = await waitForStartButton(tile);
    if (!button) {
      fail(`「开始」按钮未在限定时间内就绪`);
      return;
    }
    log.info(`点击「开始」...`);
    await clickElement(button);
    complete();
  },
});
