import { logger } from './logger';
import type * as vscode from 'vscode';

type CleanupStage = 'sessions' | 'references' | 'files';

/** Public progress stays stable; individual operations are retained for diagnostics. */
export class SessionCleanupProgress {
  deleted = 0;
  checked = 0;
  recovered = 0;
  deleting = false;
  phase = 'Reading cleanup recovery journal';
  private readonly controller = new AbortController();
  private readonly started = performance.now();
  private phaseStarted = this.started;
  private stage: CleanupStage = 'sessions';
  private fileSessions = 0;
  private scanned = 0;
  private waitLabel = '';
  private slowLogged = false;
  private lastLogAt = this.started;
  private finished = false;
  private readonly kept = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly progress: vscode.Progress<{ message?: string }>,
    private readonly token: vscode.CancellationToken,
    private readonly eligible: number
  ) {
    this.subscription = token.onCancellationRequested(() => {
      if (this.controller.signal.aborted) return;
      this.controller.abort();
      this.report();
    });
    logger.info(`Cleanup 1/3: processing ${eligible.toLocaleString()} eligible sessions.`);
    this.report();
    this.timer = setInterval(() => {
      if (this.finished) return;
      this.logSlowOperation();
      this.report();
      if (performance.now() - this.lastLogAt >= 10_000) {
        logger.info(this.message());
        this.lastLogAt = performance.now();
      }
    }, 1000);
  }

  get signal(): AbortSignal {
    if (this.token.isCancellationRequested) this.controller.abort();
    return this.controller.signal;
  }

  get activity(): string {
    return this.stage === 'sessions'
      ? 'processing sessions'
      : this.stage === 'references'
        ? 'checking shared files'
        : 'cleaning unused files';
  }

  setPhase(message: string, waitLabel = ''): void {
    this.logSlowOperation();
    this.phase = message;
    this.phaseStarted = performance.now();
    this.waitLabel = waitLabel;
    this.slowLogged = false;
  }

  keep(id: string, reason: string): void {
    this.kept.set(id, reason);
    this.setPhase(`Keeping ${id}: ${reason}`);
    logger.info(`Kept ${id}: ${reason}.`);
  }

  startReferenceCheck(sessions: number): void {
    this.stage = 'references';
    this.fileSessions = sessions;
    this.setPhase('Checking references before removing unused files');
    logger.info(
      `Cleanup 2/3: checking shared-file references for ${sessions.toLocaleString()} deleted sessions. No files are removed during this check.`
    );
    this.lastLogAt = performance.now();
    this.report();
  }

  referenceProgress(message: string, processed?: number): void {
    this.setPhase(message);
    if (processed !== undefined && Number.isSafeInteger(processed) && processed >= this.scanned)
      this.scanned = processed;
  }

  startFileCleanup(): void {
    this.stage = 'files';
    this.setPhase('Removing unused session-owned files');
    logger.info(
      `Cleanup 3/3: removing unused files for ${this.fileSessions.toLocaleString()} deleted sessions. Shared files are kept.`
    );
    this.lastLogAt = performance.now();
    this.report();
  }

  /** Only race read-only requests. A dispatched deletion must settle before returning. */
  async read<T>(message: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController();
    const signal = this.deleting
      ? deadline.signal
      : AbortSignal.any([this.signal, deadline.signal]);
    signal.throwIfAborted();
    this.setPhase(message, 'Waiting for server');
    const timeout = setTimeout(
      () => deadline.abort(new Error(`Cleanup read timed out after 30 seconds: ${message}`)),
      30_000
    );
    let cancel = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return operation(signal);
        }),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }

  finish(status: 'complete' | 'cancelled' | 'stopped', error?: Error): void {
    this.finished = true;
    logger.info(
      `Cleanup ${status} in ${duration(performance.now() - this.started)}. Sessions: ${this.checked.toLocaleString()}/${this.eligible.toLocaleString()} checked, ${this.deleted.toLocaleString()} deleted, ${this.kept.size.toLocaleString()} kept.`
    );
    if (this.fileSessions)
      logger.info(
        `File cleanup: ${this.recovered.toLocaleString()}/${this.fileSessions.toLocaleString()} sessions processed. ${status === 'complete' ? 'Shared files remain protected.' : 'Unfinished file cleanup remains saved for retry.'}`
      );
    if (status !== 'complete') logger.info(`Last operation: ${this.phase}.`);
    if (error) logger.error(error.message);
  }

  dispose(): void {
    this.finished = true;
    clearInterval(this.timer);
    this.subscription.dispose();
  }

  private logSlowOperation(): void {
    const elapsed = performance.now() - this.phaseStarted;
    if (this.slowLogged || elapsed < 5000 || this.finished) return;
    logger.info(`Still working: ${this.phase} (${duration(elapsed)}).`);
    this.slowLogged = true;
  }

  private message(): string {
    const elapsed = duration(performance.now() - this.started);
    if (this.token.isCancellationRequested)
      return `${this.deleting ? 'Finishing current deletion before stopping' : 'Stopping cleanup'} · ${this.deleted.toLocaleString()} deleted · ${elapsed}`;
    if (this.stage === 'references')
      return `2/3 Checking shared files · ${this.scanned.toLocaleString()} records scanned · ${elapsed}`;
    if (this.stage === 'files')
      return `3/3 Cleaning unused files · ${this.recovered.toLocaleString()}/${this.fileSessions.toLocaleString()} sessions · ${elapsed}`;
    const waiting =
      this.waitLabel && performance.now() - this.phaseStarted >= 5000 ? ` · ${this.waitLabel}` : '';
    return `1/3 Sessions: ${this.checked.toLocaleString()}/${this.eligible.toLocaleString()} checked · ${this.deleted.toLocaleString()} deleted${waiting} · ${elapsed}`;
  }

  private report(): void {
    if (!this.finished) this.progress.report({ message: this.message() });
  }
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
