import REPP from '@src/features/XIT/REPP/REPP.vue';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

xit.add({
  command: ['REPP', 'REPAIR_PLAN'],
  name: '维修预测',
  description:
    '照搬 PRUNplanner 模型:从 PrUn ProductionLine / productionTemplates 读取每座建筑的 per-day 净产出,对整站所有可维修建筑统一跑一次 D∈[0,180] 的 sweep,寻找日均利润最大化(avgRevenue − amortizedRepair)的最优维修触发间隔。支持 PRODUCTION 与 RESOURCES(extractor/colony/rig)建筑。价格走 userData.settings.pricing.method 与 FINRP 对齐。主面板按基地聚合(每行展示整站所有 ticker),多站模式下点击基地名可在新窗口查看该单基地的每栋建筑详情。',
  optionalParameters: '星球标识符',
  contextItems: parameters => {
    if (parameters.length === 0) {
      return [{ cmd: 'BRA' }];
    }
    const items: { cmd: string; label?: string }[] = [];
    for (const param of parameters) {
      const site = sitesStore.getByPlanetNaturalIdOrName(param);
      if (site) {
        items.push({ cmd: `XIT REPP ${getEntityNaturalIdFromAddress(site.address)}` });
      }
    }
    return items;
  },
  component: () => REPP,
});
