import { Logger } from '@src/features/XIT/ACT/runner/logger';

export interface ActionPackageConfig {
  globalOptions?: { skipMissingMaterials?: boolean };
  materialGroups: Record<string, unknown>;
  actions: Record<string, unknown>;
}

export interface ActionStep {
  type: string;
  /** 并行组标识：自动模式下同一组的连续步骤并发执行（如多窗口并发购买）。 */
  parallelGroup?: string;
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AssertFn = (condition: any, message: string) => asserts condition;

export interface ActionStepGenerateContext<
  TConfig,
> extends ActionRunnerContext<UserData.ActionData> {
  config: TConfig;
  /** 全部动作的执行配置（按动作名索引），用于读取其它动作的配置（如转移动作配置的飞船目的地）。 */
  actionsConfig: Record<string, unknown>;
  globalOptions: { skipMissingMaterials?: boolean };
  fail: (message?: string) => void;
  assert: AssertFn;
  getMaterialGroup: (name: string | undefined) => Promise<Record<string, number> | undefined>;
  emitStep: (step: ActionStep) => void;
  state: {
    WAR: {
      [exchange: string]: {
        [mat: string]: number;
      };
    };
  };
}

export interface ActionStepExecuteContext<T> extends ActionRunnerContext<T> {
  setStatus: (status: string) => void;
  waitAct: (status?: string) => Promise<void>;
  waitActionFeedback: (tile: PrunTile) => Promise<void>;
  cacheDescription: () => void;
  complete: () => void;
  skip: () => void;
  fail: (message?: string) => void;
  assert: AssertFn;
  requestTile: (Command: string) => Promise<PrunTile | undefined>;
  /** 步骤是否已被取消或失败停止（用于长步骤的清理与提前退出）。 */
  isCancelled: () => boolean;
}

export const configurableValue = 'Configure on Execution';
