/**
 * Refcounted holds that keep a message visible while an operation that may
 * re-create it is still in flight, so a server removal event arriving mid-edit
 * does not tear the row out from under the user. Overlapping holds on the same
 * message nest, and each release is idempotent because callers wire them into
 * `finally` blocks that can run more than once on an aborted path.
 */
export class DeferredMessageRemovals {
  private readonly sessions = new Map<string, Map<string, number>>();

  /** Holds `messageIds` for `sessionId` and returns the matching release. */
  defer(sessionId: string, messageIds: string[]): () => void {
    const counts = this.sessions.get(sessionId) ?? new Map<string, number>();
    this.sessions.set(sessionId, counts);
    for (const messageId of messageIds) {
      counts.set(messageId, (counts.get(messageId) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const messageId of messageIds) {
        const count = counts.get(messageId) ?? 0;
        if (count <= 1) counts.delete(messageId);
        else counts.set(messageId, count - 1);
      }
      if (counts.size === 0) this.sessions.delete(sessionId);
    };
  }

  isDeferred(sessionId: string, messageId: string): boolean {
    return (this.sessions.get(sessionId)?.get(messageId) ?? 0) > 0;
  }

  /** Tracked sessions, so tests can assert holds do not leak. */
  get trackedSessionCount(): number {
    return this.sessions.size;
  }
}
