interface FixtureSource {}

export function fixture<T>(value: T | FixtureSource | null | undefined): T {
  // SAFETY: Test callers construct the runtime shape required by T before passing it here.
  return value as T;
}
