import { act } from '@src/features/XIT/ACT/act-registry';
import { C } from '@src/infrastructure/prun-ui/prun-css';
import { deepToRaw } from '@src/utils/deep-to-raw';
import { Logger } from '@src/features/XIT/ACT/runner/logger';
import {
  TileAllocator,
  hideWindow,
  closeWindow,
} from '@src/features/XIT/ACT/runner/tile-allocator';
import { StepMachine } from '@src/features/XIT/ACT/runner/step-machine';
import { StepGenerator } from '@src/features/XIT/ACT/runner/step-generator';
import { ActionPackageConfig, ActionStep } from '@src/features/XIT/ACT/shared-types';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sleep } from '@src/utils/sleep';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { fixed0, fixed2 } from '@src/utils/format';

interface ActionRunnerOptions {
  tile: PrunTile;
  log: Logger;
  onBufferSplit: () => void;
  onStart: () => void;
  onEnd: (success: boolean) => void;
  onStatusChanged: (status: string, keepReady?: boolean) => void;
  onActReady: () => void;
  isAutoAct: () => boolean;
}

export class ActionRunner {
  private readonly tileAllocator: TileAllocator;
  private readonly stepGenerator: StepGenerator;
  private stepMachine?: StepMachine;
  private preOpenedWindows: Element[] = [];

  constructor(private options: ActionRunnerOptions) {
    this.tileAllocator = new TileAllocator(options);
    this.stepGenerator = new StepGenerator(options);
  }

  get log() {
    return this.options.log;
  }

  get isRunning() {
    return this.stepMachine?.isRunning ?? false;
  }

  async preview(pkg: UserData.ActionPackageData, config: ActionPackageConfig) {
    if (this.isRunning) {
      this.log.error('操作包已在运行中');
      return false;
    }
    // 创建副本以防止执行期间的修改。
    const copy = structuredClone(deepToRaw(pkg));
    const { steps, fail } = await this.stepGenerator.generateSteps(copy, config);
    if (steps.length === 0) {
      return false;
    }
    if (fail) {
      this.log.info('已为有效操作生成步骤：');
    }
    // 静默预加载 CXPO 价格数据
    await this.preloadPriceData(steps);
    // 计算总计并显示在最上方。
    const costByCurrency = new Map<string, number>();
    let missingPriceCount = 0;
    let buyWeight = 0;
    let buyVolume = 0;
    let transferWeight = 0;
    let transferVolume = 0;
    for (const step of steps) {
      const stepInfo = act.getActionStepInfo(step.type);
      if (stepInfo.cost) {
        const cost = stepInfo.cost(step);
        if (cost !== undefined) {
          const exchange = (step as ActionStep & { exchange?: string }).exchange;
          const currency = exchangesStore.getByCode(exchange)?.currency.code ?? '?';
          costByCurrency.set(currency, (costByCurrency.get(currency) ?? 0) + cost);
        } else {
          missingPriceCount++;
        }
      }
      const ticker = (step as ActionStep & { ticker?: string }).ticker;
      if (!ticker && step.type !== 'MTRA_BATCH') continue;
      if (stepInfo.weight !== undefined) {
        const w = stepInfo.weight(step) ?? 0;
        if (step.type === 'CXPO_BUY') {
          buyWeight += w;
        } else if (step.type === 'MTRA_TRANSFER' || step.type === 'MTRA_BATCH') {
          transferWeight += w;
        }
      }
      if (stepInfo.volume !== undefined) {
        const v = stepInfo.volume(step) ?? 0;
        if (step.type === 'CXPO_BUY') {
          buyVolume += v;
        } else if (step.type === 'MTRA_TRANSFER' || step.type === 'MTRA_BATCH') {
          transferVolume += v;
        }
      }
    }
    const totalWeight = Math.max(buyWeight, transferWeight);
    const totalVolume = Math.max(buyVolume, transferVolume);
    const totalCost = [...costByCurrency.values()].reduce((s, v) => s + v, 0);
    if (totalCost > 0 || totalWeight > 0 || totalVolume > 0) {
      const parts: string[] = [];
      if (totalCost > 0 || missingPriceCount > 0) {
        const costParts = [...costByCurrency.entries()].map(
          ([currency, amount]) => `${fixed0(amount)} ${currency}`,
        );
        let costStr = `花费 ${costParts.join(' + ')}`;
        if (missingPriceCount > 0) {
          costStr += `（${missingPriceCount} 项暂无数据）`;
        }
        parts.push(costStr);
      }
      if (totalWeight > 0) {
        parts.push(`重量 ${fixed2(totalWeight)} t`);
      }
      if (totalVolume > 0) {
        parts.push(`体积 ${fixed2(totalVolume)} m3`);
      }
      this.log.summary(`总计：${parts.join('，')}`);
    }
    if (buyWeight > 0 || buyVolume > 0) {
      const buyParts: string[] = [];
      if (buyWeight > 0) buyParts.push(`重量 ${fixed2(buyWeight)} t`);
      if (buyVolume > 0) buyParts.push(`体积 ${fixed2(buyVolume)} m3`);
      this.log.summary(`购买：${buyParts.join('，')}`);
    }
    if (transferWeight > 0 || transferVolume > 0) {
      const transferParts: string[] = [];
      if (transferWeight > 0) transferParts.push(`重量 ${fixed2(transferWeight)} t`);
      if (transferVolume > 0) transferParts.push(`体积 ${fixed2(transferVolume)} m3`);
      this.log.summary(`转移：${transferParts.join('，')}`);
    }
    // 再显示每个步骤的详情
    for (const step of steps) {
      const stepInfo = act.getActionStepInfo(step.type);
      this.log.action(stepInfo.description(step));
    }
    return !fail;
  }

  async execute(pkg: UserData.ActionPackageData, config: ActionPackageConfig) {
    if (this.isRunning) {
      this.log.error('操作包已在运行中');
      return;
    }
    // 创建副本以防止执行期间的修改。
    const copy = structuredClone(deepToRaw(pkg));
    const { steps, fail } = await this.stepGenerator.generateSteps(copy, config);
    if (fail) {
      this.log.error('操作包执行失败');
      return;
    }
    this.log.info('操作包开始执行');
    if (this.options.isAutoAct()) {
      await this.preOpenTiles(steps);
    }
    this.stepMachine = new StepMachine(steps, {
      ...this.options,
      tileAllocator: this.tileAllocator,
      onEnd: (success: boolean) => {
        this.closePreOpenedWindows();
        this.tileAllocator.closeTrackedWindows();
        if (success) {
          // 执行成功后自动关闭 ACT 执行窗口（失败/取消保留，便于查看日志）。
          this.closeActWindow();
        }
        this.options.onEnd(success);
      },
    });
    this.stepMachine.start();
  }

  act() {
    this.stepMachine?.act();
    if (!this.stepMachine?.isRunning) {
      this.stepMachine = undefined;
    }
  }

  skip() {
    this.stepMachine?.skip();
    if (!this.stepMachine?.isRunning) {
      this.stepMachine = undefined;
    }
  }

  cancel() {
    this.stepMachine?.cancel();
    this.stepMachine = undefined;
    this.closePreOpenedWindows();
    this.tileAllocator.closeTrackedWindows();
  }

  private async preloadPriceData(steps: ActionStep[]) {
    const cxTickers = steps
      .filter(s => s.type === 'CXPO_BUY')
      .map(s => {
        const data = s as ActionStep & { ticker: string; exchange: string };
        return {
          cxTicker: `${data.ticker}.${data.exchange}`,
          command: `CXPO ${data.ticker}.${data.exchange}`,
        };
      })
      .filter(({ cxTicker }) => !cxobStore.getByTicker(cxTicker));
    if (cxTickers.length === 0) return;
    const opened: { window: Element; closeWhen: Ref<boolean> }[] = [];
    try {
      for (const { command } of cxTickers) {
        const closeWhen = shallowRef(false);
        const win = await showBuffer(command, {
          force: true,
          autoSubmit: true,
          autoClose: true,
          closeWhen,
        });
        if (win !== undefined) {
          opened.push({ window: win, closeWhen });
        }
      }
      // Wait for price data, up to 5 seconds.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const allReady = cxTickers.every(({ cxTicker }) => !!cxobStore.getByTicker(cxTicker));
        if (allReady) break;
        await sleep(200);
      }
    } finally {
      // Close temporary windows: flip refs for autoClose, then close as fallback.
      for (const { window, closeWhen } of opened) {
        closeWhen.value = true;
        closeWindow(window);
      }
    }
  }

  private async preOpenTiles(steps: ActionStep[]) {
    const commands = new Set<string>();
    for (const step of steps) {
      if (step.type === 'CXPO_BUY') {
        const data = step as ActionStep & { ticker: string; exchange: string };
        commands.add(`CXPO ${data.ticker}.${data.exchange}`);
      }
    }
    if (commands.size === 0) {
      return;
    }
    this.log.info(`正在预加载 ${commands.size} 个交易所窗口...`);
    for (const command of commands) {
      this.options.onStatusChanged(`正在打开 ${command}...`);
      const window = await showBuffer(command, { force: true, autoSubmit: true });
      if (window !== undefined) {
        // 静默模式：隐藏预开窗口
        hideWindow(window);
        this.preOpenedWindows.push(window);
      }
    }
    this.options.onStatusChanged('等待订单簿数据加载...');
    await sleep(1000);
    this.log.info('交易所窗口预加载完成');
  }

  private closePreOpenedWindows() {
    for (const win of this.preOpenedWindows) {
      closeWindow(win);
    }
    this.preOpenedWindows = [];
  }

  /** 关闭 ACT 执行窗口（承载 ACT 面板的窗口）。 */
  private closeActWindow() {
    const win = this.options.tile.frame.closest(`.${C.Window.window}`);
    if (win) {
      closeWindow(win);
    }
  }
}
