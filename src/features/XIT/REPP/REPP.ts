import REPP from '@src/features/XIT/REPP/REPP.vue';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

xit.add({
  command: ['REPP', 'REPAIR_PLAN'],
  name: '维修预测',
  description:
    '照搬 PRUNplanner 模型:从 PrUn ProductionLine 读取每座建筑的 per-day 净产出,扫描 D∈[0,180] 天寻找日均利润最大化(avgRevenue − amortizedRepair)的最优维修触发间隔。仅 PRODUCTION 建筑自动读取;RESOURCES(extractor) 因无 production line 数据需手动配置。',
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
