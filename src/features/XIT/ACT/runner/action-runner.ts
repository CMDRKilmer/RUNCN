import { act } from '@src/features/XIT/ACT/act-registry';
import { deepToRaw } from '@src/utils/deep-to-raw';
import { Logger } from '@src/features/XIT/ACT/runner/logger';
import { TileAllocator } from '@src/features/XIT/ACT/runner/tile-allocator';
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
  onEnd: () => void;
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
      return;
    }
    // 创建副本以防止执行期间的修改。
    const copy = structuredClone(deepToRaw(pkg));
    const { steps, fail } = await this.stepGenerator.generateSteps(copy, config);
    if (steps.length === 0) {
      return;
    }
    // 静默预加载 CXPO 价格数据
    await this.preloadPriceData(steps);
    if (fail) {
      this.log.info('已为有效操作生成步骤：');
    }
    // 先计算总计并显示在最上方。
    // 用 ticker 聚合重量/体积：避免同一物料在 CXPO_BUY + MTRA_TRANSFER
    // 两类步骤中重复累加；但同一物料的多个购买/转移步骤仍会按 amount 累加。
    const costByCurrency = new Map<string, number>();
    let missingPriceCount = 0;
    const weightByTicker = new Map<string, number>();
    const volumeByTicker = new Map<string, number>();
    for (const step of steps) {
      const stepInfo = act.getActionStepInfo(step.type);
      if (!stepInfo) continue;
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
      if (!ticker) continue;
      if (stepInfo.weight !== undefined) {
        const w = stepInfo.weight(step) ?? 0;
        weightByTicker.set(ticker, (weightByTicker.get(ticker) ?? 0) + w);
      }
      if (stepInfo.volume !== undefined) {
        const v = stepInfo.volume(step) ?? 0;
        volumeByTicker.set(ticker, (volumeByTicker.get(ticker) ?? 0) + v);
      }
    }
    let totalWeight = 0;
    for (const w of weightByTicker.values()) {
      totalWeight += w;
    }
    let totalVolume = 0;
    for (const v of volumeByTicker.values()) {
      totalVolume += v;
    }
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
    // 再显示每个步骤的详情
    for (const step of steps) {
      const stepInfo = act.getActionStepInfo(step.type);
      if (!stepInfo) continue;
      this.log.action(stepInfo.description(step));
    }
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
      onEnd: () => {
        this.closePreOpenedWindows();
        this.options.onEnd();
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
    const opened: Element[] = [];
    for (const { command } of cxTickers) {
      const win = await showBuffer(command, { force: true, autoSubmit: true });
      if (win !== undefined) opened.push(win);
    }
    // wait for price data, up to 5 seconds
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const allReady = cxTickers.every(({ cxTicker }) => !!cxobStore.getByTicker(cxTicker));
      if (allReady) break;
      await sleep(200);
    }
    // close temp windows
    for (const win of opened) {
      const buttons = win.getElementsByClassName(C.Window.button);
      const closeBtn = Array.from(buttons).find(x => x.textContent === 'x') as
        | HTMLElement
        | undefined;
      closeBtn?.click();
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
        this.preOpenedWindows.push(window);
      }
    }
    this.options.onStatusChanged('等待订单簿数据加载...');
    await sleep(1000);
    this.log.info('交易所窗口预加载完成');
  }

  private closePreOpenedWindows() {
    for (const win of this.preOpenedWindows) {
      const buttons = win.getElementsByClassName(C.Window.button);
      const closeButton = Array.from(buttons).find(x => x.textContent === 'x') as
        | HTMLElement
        | undefined;
      closeButton?.click();
    }
    this.preOpenedWindows = [];
  }
}
