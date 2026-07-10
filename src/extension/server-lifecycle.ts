export type ServerLifecyclePhase = 'idle' | 'starting' | 'restarting' | 'disposing';

type LifecycleOperation = {
  promise: Promise<unknown>;
  controller: AbortController;
};

export class ServerLifecycleStateMachine {
  private _phase: ServerLifecyclePhase = 'idle';
  private _startAttemptId = 0;
  private _disposeGeneration = 0;
  private startOperation: LifecycleOperation | null = null;
  private restartOperation: LifecycleOperation | null = null;

  get phase(): ServerLifecyclePhase {
    return this._phase;
  }

  get isDisposing(): boolean {
    return this._phase === 'disposing' || this._phase === 'restarting';
  }

  get startAttemptId(): number {
    return this._startAttemptId;
  }

  set startAttemptId(value: number) {
    this._startAttemptId = value;
  }

  get disposeGeneration(): number {
    return this._disposeGeneration;
  }

  set disposeGeneration(value: number) {
    this._disposeGeneration = value;
  }

  beginStart(): number {
    if (this._phase !== 'restarting' && this._phase !== 'disposing') {
      this._phase = 'starting';
    }
    return this._disposeGeneration;
  }

  beginStartAttempt(): number {
    this._startAttemptId += 1;
    return this._startAttemptId;
  }

  beginDispose(cancellationMessage = 'Server start was cancelled'): number {
    this._phase = 'disposing';
    this._disposeGeneration += 1;
    this.abortOperation(this.startOperation, cancellationMessage);
    this.abortOperation(this.restartOperation, cancellationMessage);
    return this._disposeGeneration;
  }

  beginManagedRestart(cancellationMessage = 'Server start was cancelled'): number | null {
    if (this._phase === 'restarting' || this._phase === 'disposing') return null;
    this._phase = 'restarting';
    this._disposeGeneration += 1;
    this.abortOperation(this.startOperation, cancellationMessage);
    return this._disposeGeneration;
  }

  finishManagedRestart() {
    if (this._phase === 'restarting') {
      this._phase = 'idle';
    }
  }

  getRestartPromise<T>(): Promise<T> | null {
    return this.restartOperation?.promise as Promise<T> | null;
  }

  setStartPromise<T>(factory: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.startOperation) return this.startOperation.promise as Promise<T>;

    const controller = new AbortController();
    let operation: Promise<T>;
    try {
      operation = factory(controller.signal);
    } catch (err) {
      operation = Promise.reject(err);
    }
    const trackedOperation = { promise: operation, controller };
    this.startOperation = trackedOperation;
    void operation.then(
      () => this.finishStart(trackedOperation),
      () => this.finishStart(trackedOperation)
    );
    return operation;
  }

  setRestartPromise<T>(
    factory: (signal: AbortSignal) => Promise<T>,
    cancellationMessage: string
  ): Promise<T> {
    if (this.restartOperation) return this.restartOperation.promise as Promise<T>;

    const priorStart = this.startOperation;
    if (this.beginManagedRestart(cancellationMessage) === null) {
      return Promise.reject(new Error(cancellationMessage));
    }

    const controller = new AbortController();
    const promise = (async () => {
      await this.settleOperation(priorStart);
      this.throwIfAborted(controller.signal, cancellationMessage);
      return factory(controller.signal);
    })();
    const trackedOperation = { promise, controller };
    this.restartOperation = trackedOperation;
    void promise.then(
      () => this.finishRestart(trackedOperation),
      () => this.finishRestart(trackedOperation)
    );
    return promise;
  }

  async waitForOperationsSettlement(): Promise<void> {
    await Promise.all([
      this.settleOperation(this.startOperation),
      this.settleOperation(this.restartOperation),
    ]);
  }

  private finishStart(operation: LifecycleOperation) {
    if (this.startOperation === operation) {
      this.startOperation = null;
    }
    if (this._phase === 'starting') {
      this._phase = 'idle';
    }
  }

  private finishRestart(operation: LifecycleOperation) {
    if (this.restartOperation === operation) {
      this.restartOperation = null;
    }
    if (this._phase === 'restarting') {
      this._phase = 'idle';
    }
  }

  isCurrentStartAttempt(startAttemptId: number, disposeGeneration: number): boolean {
    return (
      this._phase !== 'disposing' &&
      this._startAttemptId === startAttemptId &&
      this._disposeGeneration === disposeGeneration
    );
  }

  throwIfStartCancelled(disposeGeneration: number, message: string) {
    if (this._phase === 'disposing' || this._disposeGeneration !== disposeGeneration) {
      throw new Error(message);
    }
  }

  private abortOperation(operation: LifecycleOperation | null, message: string) {
    if (operation && !operation.controller.signal.aborted) {
      operation.controller.abort(new Error(message));
    }
  }

  private async settleOperation(operation: LifecycleOperation | null): Promise<void> {
    if (!operation) return;
    try {
      await operation.promise;
    } catch {
      // Cancellation callers only need the underlying operation to stop.
    }
  }

  private throwIfAborted(signal: AbortSignal, message: string) {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : new Error(message);
  }
}
