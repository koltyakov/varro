/** A local inspection deadline is not evidence that the listener or its account changed. */
export class ProcessInspectionTimeoutError extends Error {
  override readonly name = 'ProcessInspectionTimeoutError';
}

/** Fresh evidence identified a changed managed endpoint, not an inspection failure. */
export class ManagedServerConnectionChangedError extends Error {
  override readonly name = 'ManagedServerConnectionChangedError';
}

/** The loopback port refused connections: there is no listener whose account needs consent. */
export class ServerNotListeningError extends Error {
  override readonly name = 'ServerNotListeningError';
}
