/** A local inspection deadline is not evidence that the listener or its account changed. */
export class ProcessInspectionTimeoutError extends Error {
  override readonly name = 'ProcessInspectionTimeoutError';
}

/** Fresh evidence identified a changed managed endpoint, not an inspection failure. */
export class ManagedServerConnectionChangedError extends Error {
  override readonly name = 'ManagedServerConnectionChangedError';
}
