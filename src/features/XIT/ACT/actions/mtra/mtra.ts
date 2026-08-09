import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/mtra/Edit.vue';
import Configure from '@src/features/XIT/ACT/actions/mtra/Configure.vue';
import { MTRA_BATCH } from '@src/features/XIT/ACT/action-steps/MTRA_BATCH';
import { atSameLocation, deserializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { Config } from '@src/features/XIT/ACT/actions/mtra/config';
import { AssertFn, configurableValue } from '@src/features/XIT/ACT/shared-types';

act.addAction<Config>({
  type: 'MTRA',
  description: (action, config) => {
    if (!action.group || !action.origin || !action.dest) {
      return '--';
    }

    const origin =
      action.origin == configurableValue ? (config?.origin ?? '已配置位置') : action.origin;
    const dest =
      action.dest == configurableValue ? (config?.destination ?? '已配置位置') : action.dest;
    return `转移组 [${action.group}] 从 ${origin} 到 ${dest}`;
  },
  editComponent: Edit,
  configureComponent: Configure,
  needsConfigure: data => {
    return data.origin === configurableValue || data.dest === configurableValue;
  },
  isValidConfig: (data, config) => {
    return (
      (data.origin !== configurableValue || config.origin !== undefined) &&
      (data.dest !== configurableValue || config.destination !== undefined)
    );
  },
  generateSteps: async ctx => {
    const { data, config, getMaterialGroup, emitStep } = ctx;
    const assert: AssertFn = ctx.assert;

    const materials = await getMaterialGroup(data.group);
    assert(materials, '无效的材料组');

    const serializedOrigin = data.origin === configurableValue ? config?.origin : data.origin;
    const origin = deserializeStorage(serializedOrigin);
    assert(origin, '无效的出发点');

    const serializedDest = data.dest === configurableValue ? config?.destination : data.dest;
    const dest = deserializeStorage(serializedDest);
    assert(dest, '无效的目的地');

    const isSameLocation = atSameLocation(origin, dest);
    assert(isSameLocation, '出发点和目的地不在同一位置');

    emitStep(
      MTRA_BATCH({
        from: origin.id,
        to: dest.id,
        materials: Object.entries(materials).map(([ticker, amount]) => ({ ticker, amount })),
      }),
    );
  },
});
