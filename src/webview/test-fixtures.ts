interface FixtureSource {}

export function fixture<T>(value: T | FixtureSource | null | undefined): T {
  // SAFETY: Test callers construct the runtime shape required by T before passing it here.
  return value as T;
}

/** A promise with its settle functions exposed, for tests that control async ordering. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
