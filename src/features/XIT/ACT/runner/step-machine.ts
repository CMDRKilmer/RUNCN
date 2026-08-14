import { act } from '@src/features/XIT/ACT/act-registry';
import { ActionStep } from '@src/features/XIT/ACT/shared-types';
import { Logger } from '@src/features/XIT/ACT/runner/logger';
import { TileAllocator } from '@src/features/XIT/ACT/runner/tile-allocator';
import { clickElement } from '@src/util';
import { sleep } from '@src/utils/sleep';

interface StepMachineOptions {
  tile: PrunTile;
  log: Logger;
  tileAllocator: TileAllocator;
  onBufferSplit: () => void;
  onStart: () => void;
  onEnd: (success: boolean) => void;
  onStatusChanged: (status: string, keepReady?: boolean) => void;
  onActReady: () => void;
  isAutoAct: () => boolean;
}

const AssertionError = new Error('Assertion failed');

export class StepMachine {
  private next?: ActionStep;
  private nextAct?: () => void;
  private waitActReject?: (e: unknown) => void;
  private stopped = false;
  // 并行组：自动模式下同一组的连续步骤同时启动（如多窗口并发购买），
  // 组内全部完成（activeParallelRunning 归零）后才推进到下一步。
  private activeParallelRunning = 0;

  constructor(
    private steps: ActionStep[],
    private options: StepMachineOptions,
  ) {}

  get isRunning() {
    return this.next !== undefined;
  }

  get log() {
    return this.options.log;
  }

  start() {
    this.stopped = false;
    this.options.onStart();
    this.startNext();
  }

  act() {
    if (!this.ensureRunning()) {
      return;
    }
    const nextAct = this.nextAct;
    this.nextAct = undefined;
    this.waitActReject = undefined;
    nextAct?.();
  }

  skip() {
    if (!this.ensureRunning()) {
      return;
    }
    const next = this.next;
    if (!next) {
      return;
    }
    const info = act.getActionStepInfo(next.type);
    this.log.skip(info.description(next));
    this.nextAct = undefined;
    this.waitActReject = undefined;
    // 释放被跳过步骤占用的并行计数。否则 startNext 会因 activeParallelRunning > 0
    // 提前返回，带 parallelGroup 的步骤（如 CXPO_BUY）跳过后会卡死。
    if (next.parallelGroup) {
      this.activeParallelRunning--;
    }
    this.next = undefined;
    this.startNext();
  }

  cancel() {
    if (!this.ensureRunning()) {
      return;
    }
    this.log.cancel('操作包执行已取消');
    this.stop();
  }

  stop(success = false) {
    this.stopped = true;
    this.next = undefined;
    const reject = this.waitActReject;
    this.nextAct = undefined;
    this.waitActReject = undefined;
    // 拒绝挂起的 waitAct，让步骤的 execute 走清理路径（如关闭打开的窗口）。
    reject?.(new Error('ACT_CANCELLED'));
    this.options.onEnd(success);
  }

  private startNext() {
    if (this.stopped) {
      return;
    }
    // 并行组未排空时等待组内步骤完成
    if (this.activeParallelRunning > 0) {
      return;
    }
    if (this.steps.length === 0) {
      this.log.success('操作包执行完成');
      this.stop(true);
      return;
    }
    const next = this.steps.shift()!;
    this.next = undefined;
    const group = next.parallelGroup;
    if (group && this.options.isAutoAct()) {
      // 自动模式：同一并行组的连续步骤同时启动（多窗口并发）
      this.startStep(next);
      while (this.steps.length > 0) {
        const candidate = this.steps[0];
        if (candidate.parallelGroup !== group) {
          break;
        }
        this.steps.shift();
        this.startStep(candidate);
      }
      return;
    }
    this.startStep(next);
  }

  private startStep(next: ActionStep) {
    if (next.parallelGroup) {
      this.activeParallelRunning++;
    }
    this.next = next;
    const info = act.getActionStepInfo(next.type);
    let description: string | undefined;
    const log = this.options.log;
    info
      .execute({
        data: next,
        log,
        setStatus: status => this.options.onStatusChanged(status),
        waitAct: async status => {
          status ??= description ?? info.description(next);
          await this.waitAct(status);
        },
        waitActionFeedback: async tile => {
          this.options.onStatusChanged('等待操作反馈...');
          const error = await waitActionFeedback(tile);
          if (error) {
            log.error(error);
            log.error(description ?? info.description(next));
            log.error('操作包执行失败');
            this.stop();
            return;
          }
        },
        cacheDescription: () => {
          description = info.description(next);
          this.options.onStatusChanged(description, true);
        },
        complete: async () => {
          // 等待片刻以便数据更新。
          await sleep(0);
          log.success(description ?? info.description(next));
          if (next.parallelGroup) {
            this.activeParallelRunning--;
          }
          this.next = undefined;
          this.startNext();
        },
        skip: () => this.skip(),
        fail: message => {
          if (message) {
            log.error(message);
          }
          log.error('操作包执行失败');
          this.stop();
          return;
        },
        assert: (condition, message) => {
          if (!condition) {
            log.error(message);
            throw AssertionError;
          }
        },
        requestTile: async (command, silent) => await this.requestTile(command, silent),
        isCancelled: () => this.stopped,
      })
      .catch(e => {
        if (e !== AssertionError && !(e instanceof Error && e.message === 'ACT_CANCELLED')) {
          log.runtimeError(e);
        }
        this.stop();
      });
  }

  private async requestTile(command: string, silent = true) {
    if (this.options.isAutoAct()) {
      // 自动模式：独立窗口执行（复用预开窗口），不使用右侧 companion 小窗。
      // silent=false 时窗口保持可见（如 OPEN_SFC 需要玩家在面板中手动提交飞行）。
      this.options.onStatusChanged(`正在打开 ${command}...`);
      const tile = await this.options.tileAllocator.requestWindow(command, silent);
      if (tile === undefined) {
        this.log.error(`无法打开 ${command}`);
        this.stop();
      }
      return tile;
    }
    // 手动模式：优先复用已开窗口，否则在右侧 companion 小窗中执行
    let tile = tiles.find(command, true)[0];
    if (tile !== undefined) {
      return tile;
    }
    await this.waitAct(`打开 ${command}`);
    this.options.onStatusChanged(`正在打开 ${command}...`);
    tile = await this.options.tileAllocator.requestTile(command);
    if (tile === undefined) {
      this.log.error(`无法打开 ${command}`);
      this.stop();
    }
    return tile;
  }

  private async waitAct(status: string) {
    if (this.options.isAutoAct()) {
      this.options.onStatusChanged(status);
      await sleep(50);
      return;
    }
    this.options.onStatusChanged(status);
    this.options.onActReady();
    await new Promise<void>((resolve, reject) => {
      this.nextAct = resolve;
      this.waitActReject = reject;
    });
  }

  private ensureRunning() {
    if (!this.isRunning) {
      this.log.error('操作包未在运行');
    }
    return this.isRunning;
  }
}

export async function waitActionFeedback(tile: PrunTile) {
  const overlay = await $(tile.frame, C.ActionFeedback.overlay);
  await waitActionProgress(overlay);
  if (overlay.classList.contains(C.ActionConfirmationOverlay.container)) {
    const confirm = _$$(overlay, C.Button.btn)[1];
    if (confirm === undefined) {
      return '确认覆盖层缺少确认按钮';
    }
    await clickElement(confirm);
    await waitActionProgress(overlay);
  }
  if (overlay.classList.contains(C.ActionFeedback.success)) {
    await clickElement(overlay);
    return;
  }
  if (overlay.classList.contains(C.ActionFeedback.error)) {
    const message = _$(overlay, C.ActionFeedback.message)?.textContent;
    const dismiss = _$(overlay, C.ActionFeedback.dismiss)?.textContent;
    return dismiss ? message?.replace(dismiss, '') : message;
  }

  return '未知的操作反馈覆盖层';
}

async function waitActionProgress(overlay: HTMLElement) {
  if (!overlay.classList.contains(C.ActionFeedback.progress)) {
    return;
  }
  await new Promise<void>(resolve => {
    const mutationObserver = new MutationObserver(() => {
      if (!overlay.classList.contains(C.ActionFeedback.progress)) {
        mutationObserver.disconnect();
        resolve();
      }
    });
    mutationObserver.observe(overlay, { attributes: true });
  });
}
