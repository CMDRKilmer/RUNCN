import { findBalanceOption } from '@src/core/flight/fuel-options';
import {
  FlightInputError,
  predictFormulaFlight,
  selectFormulaRoute,
  type FlightBlueprint,
  type FlightInputs,
  type FlightRequest,
  type FormulaFlight,
} from '@src/infrastructure/fio/flight-formula';

export interface FormulaPrices {
  stl?: number;
  ftl?: number;
  time: number;
}

export interface FormulaOption extends FormulaFlight {
  fuel: number;
  reactor: number;
  totalHours: number;
  fuelCost?: number;
  totalCost?: number;
}

export function calculateFormulaOptions(
  request: FlightRequest,
  blueprint: FlightBlueprint,
  input: FlightInputs,
  timeMs: number,
  prices: FormulaPrices,
  optimize: boolean,
) {
  if (
    [prices.stl, prices.ftl, prices.time].some(
      x => x !== undefined && (!Number.isFinite(x) || x < 0),
    )
  ) {
    throw new Error('燃料单价与时间价值须为非负数');
  }
  const route = selectFormulaRoute(request, blueprint, input);
  const natural = route.some(x => x.gate === undefined);
  const fuelGrid = optimize
    ? Array.from({ length: 20 }, (_, i) => (i + 1) / 20)
    : [request.fuelUsageFactor];
  const min = blueprint.performance.minReactorUsage;
  const reactors = !natural
    ? [request.reactorUsageFactor]
    : optimize
      ? [...new Set([min, ...fuelGrid.filter(x => x > min)])]
      : [request.reactorUsageFactor];
  const options: FormulaOption[] = [];
  for (const fuel of fuelGrid) {
    for (const reactor of reactors) {
      const flight = predictFormulaFlight(
        { ...request, fuelUsageFactor: fuel, reactorUsageFactor: reactor },
        blueprint,
        input,
        timeMs,
      );
      const totalHours = flight.seconds / 3600;
      const priced =
        (flight.stlFuel === 0 || prices.stl !== undefined) &&
        (flight.ftlFuel === 0 || prices.ftl !== undefined);
      const fuelCost = priced
        ? flight.stlFuel * (prices.stl ?? 0) + flight.ftlFuel * (prices.ftl ?? 0)
        : undefined;
      options.push({
        ...flight,
        fuel,
        reactor,
        totalHours,
        fuelCost,
        totalCost: fuelCost === undefined ? undefined : fuelCost + totalHours * prices.time,
      });
    }
  }
  const feasible = options.filter(x => x.feasible);
  const candidates = feasible.length > 0 ? feasible : options;
  const costBased = prices.time > 0 && candidates.every(x => x.totalCost !== undefined);
  const best = costBased
    ? candidates.reduce((a, b) => (b.totalCost! < a.totalCost! ? b : a))
    : findBalanceOption(candidates);
  if (best === undefined) {
    throw new FlightInputError('当前输入没有可计算方案');
  }
  return { best, options, costBased, feasibleCount: feasible.length, timeMs, request, prices };
}

export type FormulaOptions = ReturnType<typeof calculateFormulaOptions>;
