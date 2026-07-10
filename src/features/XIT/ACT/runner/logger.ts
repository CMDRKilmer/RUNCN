export type LogTag =
  | null
  | 'INFO'
  | 'ACTION'
  | 'SUCCESS'
  | 'ERROR'
  | 'SKIP'
  | 'WARNING'
  | 'CANCEL'
  | 'SUMMARY';

export class Logger {
  constructor(public readonly logMessage: (tag: LogTag, msg: string) => void) {}

  label(msg: string) {
    this.logMessage(null, msg);
  }

  info(msg: string) {
    this.logMessage('INFO', msg);
  }

  action(msg: string) {
    this.logMessage('ACTION', msg);
  }

  success(msg: string) {
    this.logMessage('SUCCESS', msg);
  }

  error(msg: string) {
    this.logMessage('ERROR', msg);
  }

  skip(msg: string) {
    this.logMessage('SKIP', msg);
  }

  warning(msg: string) {
    this.logMessage('WARNING', msg);
  }

  cancel(msg: string) {
    this.logMessage('CANCEL', msg);
  }

  summary(msg: string) {
    this.logMessage('SUMMARY', msg);
  }

  runtimeError(e: unknown) {
    console.error(e);
    if (e instanceof Error) {
      if (e.stack) {
        for (const line of e.stack.split('\n')) {
          this.error(line);
        }
      } else {
        this.error(e.message);
      }
    } else {
      this.error(e as string);
    }
    this.error(`操作包因运行时错误而执行失败`);
    this.error(`请将此错误报告给扩展开发者`);
  }
}
