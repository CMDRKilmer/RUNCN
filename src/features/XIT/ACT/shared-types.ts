import { Logger } from '@src/features/XIT/ACT/runner/logger';

export interface ActionPackageConfig {
  materialGroups: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  globalOptions?: { skipMissingMaterials?: boolean };
}

export interface ActionStep {
  type: string;
}

export interface ActionRunnerContext<T> {
  data: T;
  log: Logger;
}

export interface MaterialGroupGenerateContext<
  TConfig,
> extends ActionRunnerContext<UserData.MaterialGroupData> {
  config: TConfig;
  globalOptions: { skipMissingMaterials?: boolean };
  setStatus: (status: string) => void;
  setPrices: (prices: Record<string, number>) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AssertFn = (condition: any, message: string) => asserts condition;

export interface ActionStepGenerateContext<
  TConfig,
> extends ActionRunnerContext<UserData.ActionData> {
  config: TConfig;
  globalOptions: { skipMissingMaterials?: boolean };
  packageName: string;
  preview: boolean;
  fail: (message?: string) => void;
  assert: AssertFn;
  getMaterialGroup: (name: string | undefined) => Promise<Record<string, number> | undefined>;
  getMaterialGroupPrices: (name: string | undefined) => Record<string, number> | undefined;
  getMaterialGroupPlanet: (name: string | undefined) => string | undefined;
  emitStep: (step: ActionStep) => void;
  state: {
    WAR: {
      [exchange: string]: {
        [mat: string]: number;
      };
    };
    // Agent message ids handed out during this generation pass but not yet posted.
    // Every action generates its steps before any of them run, so the channel history
    // looks identical to all of them and can't keep two ships' chains apart on its own.
    reservedAgentIds: Set<string>;
  };
}

export interface ActionStepExecuteContext<T> extends ActionRunnerContext<T> {
  setStatus: (status: string) => void;
  waitAct: (status?: string, opts?: { actDelayMs?: number }) => Promise<void>;
  waitActionFeedback: (tile: PrunTile) => Promise<void>;
  cacheDescription: () => void;
  complete: () => void;
  skip: (opts?: { silent?: boolean }) => void;
  fail: (message?: string) => void;
  assert: AssertFn;
  requestTile: (Command: string) => Promise<PrunTile | undefined>;
}

export const configurableValue = 'Configure on Execution';
export const groupTargetPrefix = 'group:';
