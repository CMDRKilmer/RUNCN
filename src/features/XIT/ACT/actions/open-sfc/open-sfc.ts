import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/open-sfc/Edit.vue';
import { OPEN_SFC } from '@src/features/XIT/ACT/action-steps/OPEN_SFC';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { deserializeStorage } from '@src/features/XIT/ACT/actions/utils';

act.addAction({
  type: 'OPEN SFC',
  description: data => {
    if (!data.destination) {
      return '--';
    }
    return `打开航行控制并输入目的地 ${data.destination}`;
  },
  editComponent: Edit,
  generateSteps: async ctx => {
    const { data, actionsConfig, log, fail, emitStep } = ctx;

    // 飞船来自同包「转移」动作的执行配置（dest 配置为飞船）
    const sourceName = data.shipSourceAction;
    const sourceConfig = sourceName
      ? (actionsConfig[sourceName] as { destination?: string } | undefined)
      : undefined;
    const store = sourceConfig?.destination
      ? deserializeStorage(sourceConfig.destination)
      : undefined;
    const ship = store?.type === 'SHIP_STORE' ? shipsStore.getById(store.addressableId) : undefined;
    if (!ship) {
      log.error(`未找到飞船：请先在「${sourceName ?? '转移'}」动作的执行配置中选择飞船作为目的地`);
      fail();
      return;
    }

    emitStep(
      OPEN_SFC({
        registration: ship.registration,
        destination: data.destination ?? '',
      }),
    );
  },
});
