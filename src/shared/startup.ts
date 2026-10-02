export const STARTUP_CREDENTIAL_TIMEOUT_MS = 5_000;
export const STARTUP_HEALTH_TIMEOUT_MS = 30_000;
export const STARTUP_DEFAULT_MODEL_TIMEOUT_MS = 1_000;
export const STARTUP_TODO_TIMEOUT_MS = 1_000;

export type StartupPhase =
  | 'activation'
  | 'registration'
  | 'credentials'
  | 'claim'
  | 'cli'
  | 'configuration'
  | 'health'
  | 'ownership'
  | 'admission'
  | 'sse'
  | 'essential-data'
  | 'status'
  | 'view-restoration'
  | 'interrupted-recovery'
  | 'background-data'
  | 'initialization';

export type StartupTiming = {
  phase: StartupPhase;
  durationMs: number;
  state: 'completed' | 'failed';
};

/** Durations use one process's clock. No credentials or response bodies are recorded. */
export async function measureStartupPhase<T>(
  phase: StartupPhase,
  operation: () => PromiseLike<T>,
  record: (timing: StartupTiming) => void
): Promise<T> {
  const startedAt = performance.now();
  let state: StartupTiming['state'] = 'failed';
  try {
    const result = await operation();
    state = 'completed';
    return result;
  } finally {
    record({ phase, durationMs: Math.round(performance.now() - startedAt), state });
  }
}

/** Bound read-only waits and cancel supported operations. Owned mutations must settle separately. */
export async function withStartupDeadline<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  phase: string,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      timer = setTimeout(
        () => controller.abort(new Error(`${phase} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      interrupted,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    signal?.removeEventListener('abort', abort);
  }
}
