import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { calculateProductionRevenue } from '@src/core/production-revenue';

// REPP sweep 的 per-building per-day 净产值求解器。
// 提取到 shared 是为了让 REPP 和 BS 共用同一份语义:从 site.platforms 找到该建筑
// 对应的 PrUn ProductionLine(通过 reactorName 1:1 匹配),把 per-line 产值
// 按 line.capacity 拆分回 per-building。
// 与 core/production.ts 的 reactorName ↔ line.type 1:1 匹配保持一致;
// RESOURCES(extractor / colony / rig)与 PRODUCTION 共享同一生产数据通道
// (productionTemplates 提供无活跃订单时的产值)。
export function resolveBuildingDailyRevenue(
  building: PrunApi.Platform,
  site: PrunApi.Site,
): number | undefined {
  if (building.module.type !== 'PRODUCTION' && building.module.type !== 'RESOURCES') {
    return undefined;
  }
  const lines = productionStore.getBySiteId(site.siteId);
  if (!lines) {
    // Store 还没拉数据。getBySiteId 内部会触发 request.production,数据到达后会重新计算。
    return undefined;
  }
  const line = lines.find(l => l.type === building.module.reactorName);
  if (!line) {
    return undefined;
  }
  const perLineRevenue = calculateProductionRevenue(line);
  if (perLineRevenue === undefined || line.capacity <= 0) {
    return undefined;
  }
  return perLineRevenue / line.capacity;
}
