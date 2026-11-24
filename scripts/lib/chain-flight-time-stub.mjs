// chain-flight-time.ts（环线各段飞行时长）在 Node 下的测试替身。
//
// 仅服务 scripts/verify-chain-flight-time.mjs：由 chain-flight-time-loader.mjs 把
// store / 时钟 / 地址快照这几处浏览器侧依赖重定向到本文件。公式实现保持真实。
//
// 注入方式：用例通过 stubSet* 写入状态；所有导出读取同一份 state，避免用例之间串味
// （每个用例自己先 stubSet 一遍）。

export const state = {
  ship: undefined,
  blueprint: undefined,
  fuel: { stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0 },
  now: 0,
  inputs: undefined,
  inputsError: undefined,
  loads: [],
};

export function stubReset() {
  state.ship = undefined;
  state.blueprint = undefined;
  state.fuel = { stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0 };
  state.now = 0;
  state.inputs = undefined;
  state.inputsError = undefined;
  state.loads = [];
}

export function stubSetShip(ship) {
  state.ship = ship;
}

export function stubSetBlueprint(blueprint) {
  state.blueprint = blueprint;
}

export function stubSetFuel(fuel) {
  state.fuel = fuel;
}

export function stubSetNow(now) {
  state.now = now;
}

export function stubSetInputs(inputs) {
  state.inputs = inputs;
  state.inputsError = undefined;
}

// 让 loadFormulaInputs 抛错：模拟「起终点无法解析 / 缺星图」这类判缺场景。
export function stubSetInputsError(message) {
  state.inputs = undefined;
  state.inputsError = message;
}

// ---- 以下为被替换模块的导出面 ----

// '@src/infrastructure/fio/orbit'
export const gameNow = () => state.now;

// '@src/infrastructure/prun-api/data/ships'
export const shipsStore = {
  getByRegistration: registration =>
    state.ship !== undefined && state.ship.registration === registration ? state.ship : undefined,
};

// '@src/infrastructure/prun-api/data/blueprints'
export const blueprintsStore = {
  getByNaturalId: naturalId =>
    state.blueprint !== undefined && state.blueprint.naturalId === naturalId
      ? state.blueprint
      : undefined,
};

// '@src/features/XIT/FTC/ship-fuel'
export const shipFuelRemainingFor = () => state.fuel;

// '@src/features/XIT/FTC/formula-inputs'
export const loadFormulaInputs = async (from, to, useGateways) => {
  state.loads.push({ from, to, useGateways });
  if (state.inputsError !== undefined) {
    throw new Error(state.inputsError);
  }
  return typeof state.inputs === 'function' ? state.inputs(from, to) : state.inputs;
};

// '@src/utils/sleep'：蓝图等待循环用它退避；测试里立即返回，避免「缺蓝图」用例空等 6 s。
export const sleep = () => Promise.resolve();
