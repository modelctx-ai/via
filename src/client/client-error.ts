// The error every client operation throws. It lives apart from the error constructors and the
// mapping of upstream failures (errors.ts, a much larger module): code that only has to throw or
// pass one on, like the daemon backend, does not load those.
import type { ErrorInfo } from '../protocol';

export class ClientError extends Error implements ErrorInfo {
  readonly exitCode: ErrorInfo['exitCode'];
  readonly next?: string;
  readonly candidates?: string[];
  /**
   * True for timeouts and lost connections, the cases where a read-only call may be retried once
   * (arguments.md, "调用过程"). Not part of `ErrorInfo`.
   */
  readonly retryable: boolean;
  /**
   * `task` for the errors that stop following a task (the call may be continued with `via tasks`): not an argument problem.
   * `timeout` for the time running out while connecting or waiting for an answer: not a failure that is certain, so the
   * browse views show such a provider as `starting` rather than `failed` (discovery.md, "浏览视图"). Local to a process:
   * a daemon's reply carries `pending` instead.
   */
  kind?: 'task' | 'timeout';

  constructor(info: ErrorInfo, retryable = false) {
    super(info.message);
    this.retryable = retryable;
    this.name = 'ClientError';
    this.exitCode = info.exitCode;
    if (info.next !== undefined) this.next = info.next;
    if (info.candidates !== undefined) this.candidates = info.candidates;
  }

  /** Plain, serializable form (what a daemon response carries). */
  get info(): ErrorInfo {
    const info: ErrorInfo = { exitCode: this.exitCode, message: this.message };
    if (this.next !== undefined) info.next = this.next;
    if (this.candidates !== undefined) info.candidates = this.candidates;
    return info;
  }
}
