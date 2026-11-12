import { computeFtcPlan, shipPerformanceFor } from '@src/features/XIT/FTC/ftc-compute';
import { stlDepartureFuelCapPercent } from '@src/features/XIT/FTC/fuel-model';
import type { ShipChainPlan } from './chain-allocation';
import { measureNativeRouteFuel, type BtfFuelResult } from './native-route-btf';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  legLoadWeight,
  type NativeWaypoint,
} from './native-route-plan';

// 航点编辑器的两个百分比档位。反应堆使用量只在存在自然跃迁时写（全程系内/纯网关飞行
// 反应堆不影响时长与燃料，保持游戏默认）。
export interface NativeRouteLegPercent {
  fuelPercent: number;
  reactorPercent?: number;
}

export interface NativeRouteFuelPlan {
  // 与 waypoints 等长：首站没有入站航段，保留默认值且不写反应堆。
  legs: NativeRouteLegPercent[];
  // 未算出、最终兜底默认值的航段逐个说明。
  warnings: string[];
}

// 每段燃料消耗百分比优先用 FTC 模型算（自然航线、autoFuelGrid 全档、平衡点，与 FTC 面板同口径）；
// 该段缺服务器原生 STL 段记录（missingModelInputs 判缺）或航线不可达时改用 BTF 实测。
// 载重按该段离站时的计划舱载补进模型质量：规划期飞船通常还没装货，而质量既影响转移段速度
// 也影响着陆/起飞燃料。
export async function computeNativeRouteFuel(
  candidate: ShipChainPlan,
  waypoints: readonly NativeWaypoint[],
  signal: AbortSignal,
  onProgress: (status: string) => void,
): Promise<NativeRouteFuelPlan> {
  const registration = candidate.ship.ship.registration;
  const legCount = waypoints.length - 1;
  const legs = waypoints.map<NativeRouteLegPercent>(() => ({
    fuelPercent: DEFAULT_WAYPOINT_FUEL_PERCENT,
  }));
  const warnings: string[] = [];
  // 档位上限：离港燃料饱和点 f_cap = 10.96×STL 流量（节油引擎≈8%、标准≈16%）。
  // 超过它离港只多烧油不再加速，所以拐点/实测值都按它封顶。
  const capPercent = stlDepartureFuelCapPercent(
    shipPerformanceFor(candidate.ship.ship).stlFuelFlowRate,
  );
  const finalize = (): NativeRouteFuelPlan => {
    if (capPercent !== undefined) {
      let clamped = 0;
      for (const leg of legs) {
        if (leg.fuelPercent > capPercent) {
          leg.fuelPercent = capPercent;
          clamped++;
        }
      }
      if (clamped > 0) {
        warnings.push(
          `燃料档位按离港饱和点 ${capPercent}%（10.96×STL 流量）封顶，${clamped} 段被截断。`,
        );
      }
    }
    return { legs, warnings };
  };
  const unresolved: number[] = [];
  for (let index = 1; index <= legCount; index++) {
    signal.throwIfAborted();
    const from = waypoints[index - 1]!.location;
    const to = waypoints[index]!.location;
    onProgress(`FTC ${registration} · ${index}/${legCount} · ${from} → ${to}`);
    const result = await computeFtcPlan({
      shipRegistration: registration,
      from,
      to,
      browse: false,
      extraMassT: legLoadWeight(candidate.plan, index, legCount),
    });
    if (result.ok && result.best !== undefined && result.inputIncomplete === undefined) {
      legs[index] = {
        fuelPercent: clampPercent(result.best.fuel * 100),
        reactorPercent: result.reactorRelevant
          ? clampPercent(result.best.reactor * 100)
          : undefined,
      };
      continue;
    }
    unresolved.push(index);
    warnings.push(`FTC 跳过 ${from} → ${to}：${skipReason(result)}`);
  }
  if (unresolved.length === 0) {
    return finalize();
  }
  onProgress(`FTC 缺 ${unresolved.length} 段的模型输入，改用 BTF 试飞`);
  let measured: BtfFuelResult | undefined;
  try {
    measured = await measureNativeRouteFuel(candidate, waypoints, unresolved, signal, onProgress);
  } catch (err) {
    if (signal.aborted) {
      throw err;
    }
    const legNames = unresolved.map(
      index => `${waypoints[index - 1]!.location} → ${waypoints[index]!.location}`,
    );
    warnings.push(
      `BTF 试飞未完成（${err instanceof Error ? err.message : String(err)}）：` +
        `${legNames.join('、')} 的燃料消耗保留 ${DEFAULT_WAYPOINT_FUEL_PERCENT}%。`,
    );
    return finalize();
  }
  const stillMissing: number[] = [];
  for (const warning of measured.warnings) {
    warnings.push(warning);
  }
  for (const index of unresolved) {
    const leg = measured.legs.get(index);
    if (leg === undefined) {
      stillMissing.push(index);
      continue;
    }
    legs[index] = {
      fuelPercent: clampPercent(leg.fuel),
      reactorPercent: leg.reactor === undefined ? undefined : clampPercent(leg.reactor),
    };
  }
  if (stillMissing.length === 0) {
    return finalize();
  }
  // 试飞也没算出来的段：退回公式估算（起降距离用实测中位数），再不行就是游戏默认档。
  const fallback = await estimateLegs(
    candidate,
    waypoints,
    stillMissing,
    legCount,
    registration,
    legs,
    warnings,
  );
  for (const index of stillMissing) {
    if (!fallback.has(index)) {
      const from = waypoints[index - 1]!.location;
      const to = waypoints[index]!.location;
      warnings.push(
        `${from} → ${to} 的燃料消耗保留 ${DEFAULT_WAYPOINT_FUEL_PERCENT}%（试飞与公式估算都不可用）。`,
      );
    }
  }
  return finalize();
}

// 兜底：BTF 试飞也没结果的段用公式估算的几何再算一次 FTC（时间近似，只做最后退路）。
async function estimateLegs(
  candidate: ShipChainPlan,
  waypoints: readonly NativeWaypoint[],
  indexes: readonly number[],
  legCount: number,
  registration: string,
  legs: NativeRouteLegPercent[],
  warnings: string[],
) {
  const used = new Set<number>();
  for (const index of indexes) {
    const from = waypoints[index - 1]!.location;
    const to = waypoints[index]!.location;
    const result = await computeFtcPlan({
      shipRegistration: registration,
      from,
      to,
      browse: false,
      estimateGeometry: true,
      extraMassT: legLoadWeight(candidate.plan, index, legCount),
    });
    if (result.ok && result.best !== undefined && result.inputIncomplete === undefined) {
      legs[index] = {
        fuelPercent: clampPercent(result.best.fuel * 100),
        reactorPercent: result.reactorRelevant
          ? clampPercent(result.best.reactor * 100)
          : undefined,
      };
      used.add(index);
      warnings.push(
        `${from} → ${to}：试飞没得到结果，起降距离按公式估算补算（时间近似）。` +
          '在 SFC 为这段生成一次飞行计划（或试飞一次）即可转为原生几何。',
      );
    }
  }
  return used;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(1, Math.round(value)));
}

// 压缩成一行原因：缺少的模型输入只取条目名（冒号前），完整成因留在 FTC 面板。
function skipReason(result: { message: string; inputIncomplete?: string[] }) {
  const items = result.inputIncomplete;
  if (items === undefined || items.length === 0) {
    return result.message;
  }
  return items.map(x => x.split('：')[0]!.trim()).join('、');
}
