import { act } from '@src/features/XIT/ACT/act-registry';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import { convertToPlanetNaturalId } from '@src/core/planet-natural-id';
import { sleep } from '@src/utils/sleep';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';

interface Data {
  registration: string;
  destination: string;
}

export const OPEN_SFC = act.addActionStep<Data>({
  type: 'OPEN_SFC',
  description: data => `打开 ${data.registration} 的航行控制，目的地 ${data.destination}`,
  execute: async ctx => {
    const { data, log, setStatus, requestTile, waitAct, complete } = ctx;
    const assert: AssertFn = ctx.assert;
    const { registration, destination } = data;

    const ship = shipsStore.getByRegistration(registration);
    assert(ship, `找不到飞船 ${registration}`);

    // 静默模式不适用：玩家需要在可见的 SFC 面板中确认燃料并提交飞行。
    const tile = await requestTile(`SFC ${registration}`, false);
    if (!tile) {
      return;
    }

    setStatus('正在设置目的地...');
    const destId = convertToPlanetNaturalId(destination) ?? destination;
    // 优先在 SFC 面板内找地址输入框容器，找不到再回退全局
    const container =
      _$(tile.anchor, C.AddressSelector.container) ??
      _$(document.documentElement, C.AddressSelector.container);
    assert(container, '未找到 SFC 目的地输入框');
    const ok = await selectAddress(container, destId);
    if (!ok) {
      log.warning(`目的地「${destId}」建议选择失败，请手动确认`);
    }
    await sleep(200);

    // 不自动提交飞行：暂停让玩家在 SFC 中确认燃料并提交（自动模式下自动继续）。
    // 注意：此处不等 FTC 计算——SFC 自动联动会在后台计算并应用滑块，
    // DEPART 出发前统一等待（避免在此等待时 browseSystems 开窗干扰 SFC 面板）。
    await waitAct(`请在 SFC 中为 ${registration} 提交飞行到 ${destId}，然后继续`);
    complete();
  },
});
