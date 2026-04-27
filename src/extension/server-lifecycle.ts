export type ServerLifecyclePhase = 'idle' | 'starting' | 'restarting' | 'disposing';

export class ServerLifecycleStateMachine {
  private _phase: ServerLifecyclePhase = 'idle';
  private _startAttemptId = 0;
  private _disposeGeneration = 0;
  private _startPromise: Promise<unknown> | null = null;

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
    this._phase = 'starting';
    return this._disposeGeneration;
  }

  beginStartAttempt(): number {
    this._startAttemptId += 1;
    return this._startAttemptId;
  }

  beginDispose(): number {
    this._phase = 'disposing';
    this._disposeGeneration += 1;
    this.clearStartPromise();
    return this._disposeGeneration;
  }

  beginManagedRestart(): number | null {
    if (this._phase === 'restarting') return null;
    this._phase = 'restarting';
    this._disposeGeneration += 1;
    this.clearStartPromise();
    return this._disposeGeneration;
  }

  finishManagedRestart() {
    if (this._phase === 'restarting') {
      this._phase = 'idle';
    }
  }

  setStartPromise<T>(factory: () => Promise<T>): Promise<T> {
    if (this._startPromise) return this._startPromise as Promise<T>;
    const promise = factory().finally(() => {
      if (this._startPromise === promise) {
        this._startPromise = null;
      }
      if (this._phase === 'starting') {
        this._phase = 'idle';
      }
    });
    this._startPromise = promise;
    return promise;
  }

  clearStartPromise() {
    this._startPromise = null;
  }

  isCurrentStartAttempt(startAttemptId: number, disposeGeneration: number): boolean {
    return (
      !this.isDisposing &&
      this._startAttemptId === startAttemptId &&
      this._disposeGeneration === disposeGeneration
    );
  }

  throwIfStartCancelled(disposeGeneration: number, message: string) {
    if (this.isDisposing || this._disposeGeneration !== disposeGeneration) {
      throw new Error(message);
    }
  }
}
