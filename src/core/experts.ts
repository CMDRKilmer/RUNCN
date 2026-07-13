// 专家培养 ETA 计算的共享逻辑。
// 被 basic/exp-expert-eta.ts 和 XIT/EXP 面板共用。

// https://handbook.apex.prosperousuniverse.com/wiki/efficiency-factors/index.html#expert-spawn-rates--bonuses
export const EXPERT_DAYS = [10.0, 12.5, 57.57, 276.5, 915.1];
export const MS_IN_DAY = 24 * 60 * 60 * 1000;

export function getTotalExperts(entry: PrunApi.ExpertFieldEntry): number {
  return entry.current + entry.available;
}

export function getExperience(
  order: PrunApi.ProductionOrder,
  line: PrunApi.ProductionLine,
): number {
  const recipeId = order.recipeId;
  const template = line.productionTemplates.find(x => x.id === recipeId);
  if (!template) {
    return 0;
  }

  const orderSize = order.outputs[0].amount / template.outputFactors[0].factor;
  return template.experience * orderSize;
}

export function calculateEta(entry: PrunApi.ExpertFieldEntry, lines: PrunApi.ProductionLine[]) {
  if (lines.length === 0) {
    return undefined;
  }

  const remainingExperience =
    (1 - entry.progress) * EXPERT_DAYS[getTotalExperts(entry)] * MS_IN_DAY;
  const inProgressOrders = lines
    .flatMap(line =>
      line.orders
        .filter(x => x.completion)
        .map(x => ({
          order: x,
          completion: x.completion!.timestamp,
          experience: getExperience(x, line),
        })),
    )
    .sort((a, b) => a.completion - b.completion);
  if (inProgressOrders.length === 0) {
    return undefined;
  }

  // 如果当前进行中的订单能完成该专家升级，则返回该时间
  let accumulatedExperience = 0;
  for (const order of inProgressOrders) {
    accumulatedExperience += order.experience;
    if (accumulatedExperience >= remainingExperience) {
      return {
        type: 'precise',
        ms: order.completion,
      };
    }
  }

  // 否则，估算剩余天数
  let experiencePerMs = 0;
  for (const line of lines) {
    experiencePerMs += line.capacity * line.efficiency;
  }

  return {
    type: 'estimate',
    ms: remainingExperience / experiencePerMs,
  };
}
