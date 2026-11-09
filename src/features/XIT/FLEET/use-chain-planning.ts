import { computed, ref, watch, onScopeDispose } from 'vue';
import { planChainRoute } from './chain-planner';
import {
  splitChainPlanAcrossShips,
  shipOriginNaturalId,
  shipWarehouseStock,
  buildCombinedCapacity,
  shipChainCapacity,
  chainStopShipmentSizes,
  planTimeBalancedSegments,
} from './chain-allocation';
import { estimateChainFlightTimes, type ChainFlightEstimate } from './chain-flight-time';
import type { ChainPlannerBase, ChainPlan } from './chain-types';
import type { DispatchShip } from './utils';
import { shipLabel, formatFlightDuration } from './chain-format';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { fixed0 } from '@src/utils/format';
import { gameNow } from '@src/infrastructure/fio/orbit';

export function useChainPlanning(input: {
  ships: () => DispatchShip[];
  bases: () => ChainPlannerBase[];
  runs: () => { shipId: string; run: UserData.ChainRun }[];
}) {
  const selectedShips = computed(input.ships);
  const selectedBases = computed(input.bases);
  const activeRuns = computed(input.runs);
  // ── 各段飞行时间预估（FTC 最优燃油计划） ─────────────────────
  // 每艘船一条环线预估（shipId → 逐段时长）。计算在后台进行，
  // 显示在「飞行」列与汇总「飞行时长」行；下游基地用未来预计位置计算。
  // 声明在本节顶部：环线规划（plan）读取预估推导各站到达时刻产出。
  const flightEstimates = ref<Map<string, ChainFlightEstimate>>(new Map());
  const flightTimesLoading = ref(false);

  // ── 环线计划（合并容量，单一路线） ───────────────────────────
  const planOrigin = computed(() =>
    selectedShips.value.length > 0 ? shipOriginNaturalId(selectedShips.value[0]!) : '',
  );

  // 规划环线（可选传入各站预计到达小时数）：取货量按到达时预计库存计算——
  // 飞行期间基地继续生产，到港时实际可提取量 = 当前库存 + 日均净变化 × 到达前小时数。
  function runPlanChainRoute(arrivalHours?: Map<string, number>) {
    if (selectedBases.value.length === 0 || selectedShips.value.length === 0) {
      return undefined;
    }
    const capacity = buildCombinedCapacity(selectedShips.value);
    if (!capacity) {
      return undefined;
    }
    // 合并规划保留候选站点，交易所供应限制由分船后的子规划应用。
    return planChainRoute({
      originNaturalId: planOrigin.value,
      capacity,
      bases: selectedBases.value,
      // 出发地空间站仓库库存：组内产出的缺口由仓库以「取货」补足。
      originStock: shipWarehouseStock(selectedShips.value[0]!),
      ...(arrivalHours !== undefined ? { arrivalHoursByNaturalId: arrivalHours } : {}),
    });
  }

  // 基础规划（未含到达时刻产出）：决定站点顺序，供飞行预估与「站→船」映射。
  const basePlan = computed(() => runPlanChainRoute());

  // ── 多船时间均衡分段（优先按速度分配） ───────────────────────
  // 并行出动时整条环线完成一轮补给的总耗时 = 最慢那艘船的闭环时长（瓶颈船）。
  // 给每艘可用船沿「整条合并环线」预估一次飞行（异步），用前缀和把任意连续段
  // 代价 O(1) 求出，再经 DP 求 makespan 最小的连续分段——多船真正并行提速、
  // 快船多跑慢船少跑；空段（不参与）由 DP 自动决定，避免切得太碎徒增往返。
  // 预估/求解就绪前退回按舱容贪心（旧行为），就绪后自动切换。
  // 注意：分配只决定「哪艘船跑哪些站」，不改站点顺序——顺序由 basePlan（拓扑序）
  // 决定，分配与飞行预估之间无循环依赖。
  const usableChainShips = computed(() =>
    selectedShips.value.filter(s => {
      const c = shipChainCapacity(s);
      return c !== undefined && (c.freeWeight > 0 || c.freeVolume > 0);
    }),
  );

  interface TimeAlloc {
    // 与 usableChainShips 对齐：每艘船分配的连续站点 naturalId（空数组 = 不参与）。
    ranges: string[][];
    shipIds: string[];
    // 与 usableChainShips 对齐：每艘船预计闭环时长（小时，前缀和近似，用于瓶颈展示）。
    loopHours: number[];
    // 分配对应的合并环线站点序列（校验当前 plan 是否仍适用）。
    stopIds: string[];
    // 容量诊断：瓶颈站无法转给相邻非空段船的提示（真实吨位/体积）。
    notes?: string[];
  }
  const timeAlloc = ref<TimeAlloc | undefined>(undefined);
  const allocStatus = ref<'idle' | 'computing' | 'ready'>('idle');

  // 触发键：站点序列 / 参与船集合 / 船数据就绪度变化才重算；量变（仓库、生产
  // 等频繁刷新）不触发，避免反复做异步飞行预估。与 basePlan 对象分离，
  // 也避免 basePlan 因量化变化重算时无谓重跑预估。
  const allocStopKey = computed(() =>
    (basePlan.value?.stops ?? []).map(s => s.naturalId).join('>'),
  );
  const allocShipKey = computed(() => usableChainShips.value.map(s => s.ship.id).join(','));

  let allocToken = 0;
  async function computeTimeAlloc() {
    const token = ++allocToken;
    const p = basePlan.value;
    const ships = usableChainShips.value;
    if (!p || p.stops.length < 2 || ships.length < 2 || !shipsStore.fetched.value) {
      timeAlloc.value = undefined;
      allocStatus.value = 'idle';
      return;
    }
    allocStatus.value = 'computing';
    // 清掉旧分配：配置/船集变化后的重算期间不再套用旧切法（旧 ranges 可能
    // 与新船集/站点不匹配），退回舱容贪心做中间态，就绪后自动切到时间均衡。
    timeAlloc.value = undefined;
    const stopIds = p.stops.map(s => s.naturalId);
    const stops = p.stops.map(s => ({ naturalId: s.naturalId, planetName: s.planetName }));
    try {
      const capacities = ships.map(s => {
        const c = shipChainCapacity(s)!;
        return { freeWeight: c.freeWeight, freeVolume: c.freeVolume };
      });
      const loopLegHours: number[][] = [];
      let complete = true;
      for (const ship of ships) {
        const est = await estimateChainFlightTimes({
          ship: ship.ship,
          origin: shipOriginNaturalId(ship),
          stops,
        });
        if (token !== allocToken) {
          return; // 计划/配置已变化，丢弃过期结果。
        }
        // 判缺段 ⇒ est.ok = false（chain-flight-time：ok = legs.every(l => l.ok)，判缺段
        // 不再把 0 小时伪装成 ok）⇒ complete = false ⇒ alloc = undefined ⇒ allocFor 返回
        // undefined ⇒ splitChainPlanAcrossShips 退回舱容贪心（旧行为）。判缺段的 0 小时
        // 因此永远到不了 planTimeBalancedSegments，故此门不放宽。
        if (!est.ok || est.legs.length !== stopIds.length + 1) {
          complete = false;
          break;
        }
        loopLegHours.push(est.legs.map(l => l.hours));
      }
      if (token !== allocToken) {
        return;
      }
      const alloc = complete
        ? planTimeBalancedSegments({
            loopLegHours,
            capacities,
            stopSizes: chainStopShipmentSizes(p),
          })
        : undefined;
      if (token !== allocToken) {
        return;
      }
      if (!alloc) {
        timeAlloc.value = undefined;
        allocStatus.value = 'idle';
        return;
      }
      // 容量诊断：瓶颈船（最慢段）相邻的非空段船若因剩余舱容装不下边界站而无法
      // 接手分担，用真实吨位/体积说明——解释为何瓶颈无法被摊薄（常见是大宗到货
      // 的单站体积超过小/中船的剩余体积，如整站 > 1000m³）。仅当确实装不下才提示，
      // 能装下而未转移属时间最优，不误报。
      const notes: string[] = [];
      {
        const sizes = chainStopShipmentSizes(p);
        const n = stopIds.length;
        let maxIdx = 0;
        for (let j = 1; j < alloc.hours.length; j++) {
          if (alloc.hours[j]! > alloc.hours[maxIdx]!) {
            maxIdx = j;
          }
        }
        const sumRange = (from: number, to: number) => {
          let w = 0;
          let v = 0;
          for (let k = from; k < to; k++) {
            w += sizes[k]!.weight;
            v += sizes[k]!.volume;
          }
          return { w, v };
        };
        const tryTransfer = (neighborIdx: number, stopIdx: number) => {
          if (neighborIdx < 0 || neighborIdx >= ships.length || stopIdx < 0 || stopIdx >= n) {
            return;
          }
          // alloc 是 planTimeBalancedSegments 的原始产物：ranges 是按船对齐的**半开
          // 下标区间 [start,end)**（空段 = start === end），不是站点 id 数组。此前用
          // `.length` 判断参与与否恒得 undefined，导致下方诊断整体失效。
          if (alloc.ranges[neighborIdx]!.start >= alloc.ranges[neighborIdx]!.end) {
            return; // 相邻船本就不参与，无需提示。
          }
          const cap = capacities[neighborIdx]!;
          const own = sumRange(alloc.ranges[neighborIdx]!.start, alloc.ranges[neighborIdx]!.end);
          const extra = sizes[stopIdx]!;
          const freeW = cap.freeWeight - own.w;
          const freeV = cap.freeVolume - own.v;
          if (extra.weight <= freeW && extra.volume <= freeV) {
            return; // 能装下：DP 未转移是时间最优，不误报。
          }
          notes.push(
            `${shipLabel(ships[neighborIdx]!)} 接不下 ${p.stops[stopIdx]!.planetName}（该站约 ` +
              `${fixed0(extra.weight)}t/${fixed0(extra.volume)}m³，其剩余约 ` +
              `${fixed0(Math.max(0, freeW))}t/${fixed0(Math.max(0, freeV))}m³），` +
              `该站只能留在瓶颈船 ${shipLabel(ships[maxIdx]!)}（约 ${formatFlightDuration(
                alloc.hours[maxIdx]! * 3600000,
              )}）。`,
          );
        };
        // 左侧非空段船接手瓶颈首站（= 左段末站）；右侧非空段船接手瓶颈末站（= 右段首站）。
        for (let j = maxIdx - 1; j >= 0; j--) {
          if (alloc.ranges[j]!.start < alloc.ranges[j]!.end) {
            tryTransfer(j, alloc.ranges[j]!.end);
            break;
          }
        }
        for (let j = maxIdx + 1; j < alloc.ranges.length; j++) {
          if (alloc.ranges[j]!.start < alloc.ranges[j]!.end) {
            tryTransfer(j, alloc.ranges[j]!.start - 1);
            break;
          }
        }
      }
      timeAlloc.value = {
        ranges: alloc.ranges.map(r => stopIds.slice(r.start, r.end)),
        loopHours: alloc.hours,
        stopIds,
        shipIds: ships.map(x => x.ship.id),
        notes,
      };
      allocStatus.value = 'ready';
    } catch (e) {
      console.warn('[XIT/FLEET] time-balanced alloc failed', e);
      if (token === allocToken) {
        timeAlloc.value = undefined;
        allocStatus.value = 'idle';
      }
    }
  }

  watch(
    [allocStopKey, allocShipKey, () => shipsStore.fetched.value],
    () => {
      void computeTimeAlloc();
    },
    { immediate: true },
  );

  // 当前 plan 对应的时间均衡分段（站点序列匹配才有效；否则退回舱容贪心）。
  function allocFor(plan: ChainPlan | undefined): string[][] | undefined {
    const ta = timeAlloc.value;
    if (
      !ta ||
      !plan ||
      plan.stops.length !== ta.stopIds.length ||
      ta.shipIds.join() !== usableChainShips.value.map(x => x.ship.id).join()
    ) {
      return undefined;
    }
    for (let i = 0; i < plan.stops.length; i++) {
      if (plan.stops[i]!.naturalId !== ta.stopIds[i]) {
        return undefined;
      }
    }
    return ta.ranges;
  }

  // ── 多船分配结果 ─────────────────────────────────────────────
  // 并行分段：每艘船跑航线的连续一段，同时出动。有时间均衡结果时按它切段
  //（总耗时 ≈ 最慢船的闭环时长），否则退回按舱容贪心切段（旧行为）。
  // baseShipPlans 不含到达时刻产出（飞行预估依赖它，避免循环依赖）。
  const baseShipPlans = computed(() => {
    const p = basePlan.value;
    if (!p || selectedShips.value.length === 0) {
      return [];
    }
    return splitChainPlanAcrossShips(
      p,
      selectedShips.value,
      selectedBases.value,
      undefined,
      allocFor(p),
    );
  });

  // 各站预计到达时刻（相对规划时刻的小时数）：由飞行预估（异步）推导。
  // 预估就绪前为空 Map（取货按当前库存规划）；每站取服务该船的环线预估
  // 到达时刻（多船分段时各船并行出动、分别到站）。
  const arrivalHoursByNaturalId = computed(() => {
    const map = new Map<string, number>();
    for (const sp of baseShipPlans.value) {
      const est = flightEstimates.value.get(sp.ship.ship.id);
      if (!est) {
        continue;
      }
      // 预估不完整（含判缺段）⇒ 整船不提供到达时刻，退回基础规划（= 未就绪时同一路径）。
      // 判缺段不推进累计时长，其后各段的 arriveAtMs 都按「缺的那段 0 小时」算、系统偏早；
      // 而缺段自身那一站，下面的 !leg.ok 只剔除它自己（其余站点的偏早时刻仍会被当成真值）。
      // 偏早的时刻传下去 = 到港产出/消耗被算成更早到货。宁可不算到港产出，也不传偏早值。
      if (!est.ok) {
        continue;
      }
      const startAtMs = est.legs[0]?.departAtMs ?? gameNow();
      for (let i = 0; i < sp.plan.stops.length; i++) {
        const stop = sp.plan.stops[i]!;
        const leg = est.legs.at(i);
        if (leg === undefined || !leg.ok) {
          continue;
        }
        const hours = (leg.arriveAtMs - startAtMs) / 3600000;
        if (hours <= 0) {
          continue;
        }
        const existing = map.get(stop.naturalId);
        if (existing === undefined || hours < existing) {
          map.set(stop.naturalId, hours);
        }
      }
    }
    return map;
  });

  // 主规划：含到达时刻预计产出（取货量更贴近到港时实际可提取量）。
  // 飞行预估就绪后自动重算；未就绪时复用基础规划结果（避免重复计算）。
  const plan = computed(() => {
    const hours = arrivalHoursByNaturalId.value;
    return hours.size === 0 ? basePlan.value : runPlanChainRoute(hours);
  });

  const loading = computed(
    () =>
      selectedBases.value.length > 0 && selectedShips.value.length > 0 && plan.value === undefined,
  );

  // 过滤提示必须读取主规划：过滤站点不会进入按船拆分后的子规划。
  const filteredStopNotices = computed(() => plan.value?.filteredStops ?? []);

  // 主多船分配结果（用于展示与执行）。
  // 传到达时刻产出映射，使分段子计划的取货量也按到港时预计库存计算。
  const shipPlans = computed(() => {
    const p = plan.value;
    if (!p || selectedShips.value.length === 0) {
      return [];
    }
    return splitChainPlanAcrossShips(
      p,
      selectedShips.value,
      selectedBases.value,
      arrivalHoursByNaturalId.value,
      allocFor(p),
    );
  });
  const hasStops = computed(() => shipPlans.value.length > 0);

  // 未参与分配的船（无货舱，或船多于站点数）。
  const unusedShipCount = computed(() =>
    selectedShips.value.length > 0 ? selectedShips.value.length - shipPlans.value.length : 0,
  );

  // 时间均衡状态横幅：计算中提示 + 就绪后各船预计闭环时长与瓶颈船。
  const allocBanner = computed<{ kind: 'info' | 'ok'; text: string } | undefined>(() => {
    if (allocStatus.value === 'computing') {
      return { kind: 'info', text: '正在按飞行时长均衡分配船只（预估各船环线时长）…' };
    }
    const ta = timeAlloc.value;
    if (!ta || ta.loopHours.length < 2) {
      return undefined;
    }
    const used = usableChainShips.value;
    // 该船当前分配段的精确实测（飞行预估 watch 对已定段的闭环实测）：
    // 与 ta.ranges[j] 匹配（首段目标 = 段首站、段数一致）才采用，保证横幅
    // 与下方各船卡片的「飞行时长」同口径；分配刚切换、精确实测未就绪时
    // 回退到 DP 估算（ta.loopHours）。
    const preciseHoursOf = (j: number): number | undefined => {
      const stops = ta.ranges[j]!;
      if (stops.length === 0) {
        return undefined;
      }
      const est = flightEstimates.value.get(used[j]!.ship.id);
      if (
        est !== undefined &&
        est.ok &&
        est.legs.length === stops.length + 1 &&
        (est.legs[0]?.to ?? '').toUpperCase() === stops[0]!.toUpperCase()
      ) {
        return est.totalHours;
      }
      return undefined;
    };
    // 仅统计实际承担站段的船（空段 = 不参与，不列出）。
    const parts: string[] = [];
    let maxIdx = -1;
    let maxHours = 0;
    for (let j = 0; j < used.length; j++) {
      if (ta.ranges[j]!.length === 0) {
        continue;
      }
      const hours = preciseHoursOf(j) ?? ta.loopHours[j] ?? 0;
      if (hours <= 0) {
        continue;
      }
      parts.push(`${shipLabel(used[j]!)}：${formatFlightDuration(hours * 3600000)}`);
      if (hours > maxHours) {
        maxHours = hours;
        maxIdx = j;
      }
    }
    if (maxIdx < 0) {
      return undefined;
    }
    return {
      kind: 'ok',
      text: `时间均衡分段：${parts.join(' ／ ')}。整条环线首轮约 ${formatFlightDuration(
        maxHours * 3600000,
      )} 完成（瓶颈：${shipLabel(used[maxIdx]!)}）。`,
    };
  });

  // 环线计划变化时逐段估算飞行时间（FTC 最优燃油计划，下游基地用未来位置）。
  // 同时响应规划（baseShipPlans）与执行中环线（activeRuns）：执行中船已离港时不在
  // eligibleShips / baseShipPlans 中，但飞行列仍需读取预估——按 shipId 收集
  // 起点与站点一并估算。计划为空（未规划/无执行中）时保留已有预估。
  // 预估基于 baseShipPlans（不含到达时刻产出）：到达时刻产出只影响取货量、
  // 不影响站点顺序，避免「预估 → 规划 → 预估」循环。
  let flightTimeToken = 0;
  function registerFlightTimeWatch() {
    watch(
      [baseShipPlans, activeRuns, () => shipsStore.fetched.value],
      async ([plans, runs, shipsFetched]) => {
        const token = ++flightTimeToken;
        // 船数据未就绪时跳过（估算需读取飞船实时质量/加速度与蓝图）。
        if (!shipsFetched) {
          flightTimesLoading.value = false;
          return;
        }
        // 统一为 shipId → {ship, origin, stops}：规划取实时计划，执行中取链快照/持久化链记录。
        const entries = new Map<
          string,
          {
            ship: PrunApi.Ship;
            origin: string;
            stops: { naturalId: string; planetName: string }[];
          }
        >();
        for (const sp of plans) {
          if (sp.plan.stops === undefined) {
            continue;
          }
          entries.set(sp.ship.ship.id, {
            ship: sp.ship.ship,
            origin: sp.plan.originNaturalId,
            stops: sp.plan.stops.map(s => ({
              naturalId: s.naturalId,
              planetName: s.planetName,
            })),
          });
        }
        for (const run of runs) {
          if (entries.has(run.shipId)) {
            continue;
          }
          const ship = shipsStore.getById(run.shipId);
          if (!ship) {
            continue;
          }
          if (run.run.stops === undefined) {
            continue;
          }
          entries.set(run.shipId, {
            ship,
            origin: run.run.originNaturalId,
            stops: run.run.stops.map(s => ({ naturalId: s.naturalId, planetName: s.planetName })),
          });
        }
        if (entries.size === 0) {
          flightTimesLoading.value = false;
          return;
        }
        flightTimesLoading.value = true;
        const estimates = new Map<string, ChainFlightEstimate>(flightEstimates.value);
        try {
          for (const [shipId, info] of entries) {
            const est = await estimateChainFlightTimes(info);
            if (token !== flightTimeToken) {
              return; // 计划已变化，丢弃过期结果。
            }
            estimates.set(shipId, est);
          }
          if (token !== flightTimeToken) {
            return;
          }
          flightEstimates.value = estimates;
        } catch (e) {
          console.warn('[XIT/FLEET] flightTime estimate failed', e);
        } finally {
          if (token === flightTimeToken) {
            flightTimesLoading.value = false;
          }
        }
      },
      { immediate: true },
    );
  }

  registerFlightTimeWatch();
  onScopeDispose(() => {
    allocToken++;
    flightTimeToken++;
  });
  return {
    flightEstimates,
    flightTimesLoading,
    usableChainShips,
    allocStatus,
    timeAlloc,
    shipPlans,
    basePlan,
    loading,
    hasStops,
    unusedShipCount,
    allocBanner,
    filteredStopNotices,
  };
}
