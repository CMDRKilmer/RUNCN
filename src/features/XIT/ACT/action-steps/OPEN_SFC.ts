import { act } from '@src/features/XIT/ACT/act-registry';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import { convertToPlanetNaturalId } from '@src/core/planet-natural-id';
import { sleep } from '@src/utils/sleep';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';

interface Data {
  registration: string;
  destination: string;
  followedByDepart: boolean;
}

export const OPEN_SFC = act.addActionStep<Data>({
  type: 'OPEN_SFC',
  description: data => `打开 ${data.registration} 的航行控制，目的地 ${data.destination}`,
  execute: async ctx => {
    const { data, log, setStatus, requestTile, waitAct, complete, fail, isCancelled } = ctx;
    const assert: AssertFn = ctx.assert;
    const { registration, destination, followedByDepart } = data;

    const ship = shipsStore.getByRegistration(registration);
    assert(ship, `找不到飞船 ${registration}`);

    // 静默模式不适用：玩家需要在可见的 SFC 面板中确认燃料并提交飞行。
    const tile = await requestTile(`SFC ${registration}`, false);
    if (!tile) {
      return;
    }

    setStatus('正在设置目的地...');
    const destId = convertToPlanetNaturalId(destination) ?? destination;
    const deadline = Date.now() + 15_000;
    while (_$(tile.anchor, C.AddressSelector.input) === undefined) {
      if (isCancelled()) {
        return;
      }
      if (Date.now() >= deadline) {
        fail(`未找到 ${registration} 的 SFC 目的地输入框`);
        return;
      }
      await sleep(100);
    }
    const ok = await selectAddress(tile.anchor, destId, { allowPartial: !followedByDepart });
    if (isCancelled()) {
      return;
    }
    if (!ok) {
      if (followedByDepart) {
        fail(`${registration} 未能设置目的地「${destId}」`);
        return;
      }
      log.warning(`目的地「${destId}」建议选择失败，请手动确认`);
    }

    await waitAct(
      followedByDepart
        ? `目的地已设置为 ${destId}，继续后将为 ${registration} 发船`
        : `请在 SFC 中为 ${registration} 提交飞行到 ${destId}，然后继续`,
    );
    complete();
  },
});
