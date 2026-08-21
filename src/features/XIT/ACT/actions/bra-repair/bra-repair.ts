import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/bra-repair/Edit.vue';
import { BRA_REPAIR } from '@src/features/XIT/ACT/action-steps/BRA_REPAIR';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { userData } from '@src/store/user-data';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';

act.addAction({
  type: 'BRA Repair',
  description: data => {
    if (!data.base) {
      return '--';
    }
    const threshold = data.threshold ?? userData.settings.repair.threshold;
    return `提交 ${data.base} 状况低于 ${threshold}% 建筑的维修`;
  },
  editComponent: Edit,
  generateSteps: async ctx => {
    const { data, emitStep } = ctx;
    const assert: AssertFn = ctx.assert;

    assert(data.base, '未设置维修基地');
    const site = sitesStore.getByPlanetNaturalIdOrName(data.base);
    assert(site, `未找到基地 ${data.base}`);

    const threshold = data.threshold ?? userData.settings.repair.threshold;
    emitStep(BRA_REPAIR({ base: data.base, threshold }));
  },
});
