import type { ShellInfo } from '@opencode/client';
import { asRecord, isNumber, isString, type UnknownRecord } from '../shared/type-utils';

/** Shell calls settle before their background processes and automatic follow-up turns do. */
export class OpenCodeV2BackgroundWork {
  private readonly shells = new Map<
    string,
    { sessionID: string; directory?: string; startedAt?: number }
  >();
  private readonly mutations = new Map<string, number>();
  private readonly sessionMutations = new Map<string, number>();
  private readonly waiting = new Map<string, number | null>();
  private readonly stopped = new Set<string>();
  private revision = 0;

  observe(type: string, data: UnknownRecord, directory?: string): void {
    if (type === 'shell.created') {
      const info = asRecord(data.info);
      const sessionID = asRecord(info?.metadata)?.sessionID;
      if (isString(info?.id) && isString(sessionID) && info.status === 'running') {
        const startedAt = asRecord(info.time)?.started;
        this.shells.set(info.id, {
          sessionID,
          directory,
          startedAt: isNumber(startedAt) && Number.isFinite(startedAt) ? startedAt : undefined,
        });
        this.mutations.set(info.id, ++this.revision);
      }
    }
    if ((type === 'shell.exited' || type === 'shell.deleted') && isString(data.id)) {
      const sessionID = this.shells.get(data.id)?.sessionID;
      this.shells.delete(data.id);
      this.mutations.set(data.id, ++this.revision);
      // Keep Waiting through the gap before the completion notification resumes the model.
      if (sessionID && this.waiting.has(sessionID) && this.shellIDs(sessionID).length === 0)
        this.waiting.set(sessionID, Date.now());
    }
    if (!isString(data.sessionID)) return;
    if (type.startsWith('session.execution.') || type.startsWith('session.step.'))
      this.sessionMutations.set(data.sessionID, ++this.revision);
    if (
      type === 'session.execution.succeeded' ||
      (type === 'session.step.ended' && data.finish === 'stop')
    ) {
      if (this.shellIDs(data.sessionID).length > 0) this.waiting.set(data.sessionID, null);
      else this.waiting.delete(data.sessionID);
    }
    if (
      type === 'session.step.started' ||
      type === 'session.execution.failed' ||
      type === 'session.execution.interrupted' ||
      type === 'session.deleted'
    ) {
      this.waiting.delete(data.sessionID);
    }
    if (type === 'session.execution.started') this.stopped.delete(data.sessionID);
    if (type === 'session.execution.failed' || type === 'session.execution.interrupted')
      this.stopped.add(data.sessionID);
  }

  isWaiting(sessionID: string): boolean {
    return this.waiting.has(sessionID);
  }

  shellIDs(sessionID: string): string[] {
    return [...this.shells].flatMap(([id, shell]) => (shell.sessionID === sessionID ? [id] : []));
  }

  startedAt(sessionID: string): number | undefined {
    const starts = [...this.shells.values()].flatMap((shell) =>
      shell.sessionID === sessionID && shell.startedAt !== undefined ? [shell.startedAt] : []
    );
    return starts.length > 0 ? Math.min(...starts) : undefined;
  }

  snapshotVersion(): number {
    return this.revision;
  }

  reconcile(
    shells: ShellInfo[],
    activeSessionIDs: ReadonlySet<string>,
    directory: string | undefined,
    version: number
  ): string[] {
    const snapshot = new Map(
      shells.flatMap((shell) => {
        const sessionID = shell.metadata.sessionID;
        return shell.status === 'running' && isString(sessionID)
          ? [[shell.id, { sessionID, directory, startedAt: shell.time.started }] as const]
          : [];
      })
    );
    for (const id of new Set([...this.shells.keys(), ...snapshot.keys()])) {
      if ((this.mutations.get(id) ?? 0) > version) continue;
      if (this.shells.has(id) && this.shells.get(id)?.directory !== directory) continue;
      const shell = snapshot.get(id);
      if (shell) this.shells.set(id, shell);
      else this.shells.delete(id);
    }
    const running = new Set([...this.shells.values()].map((shell) => shell.sessionID));
    for (const sessionID of running) {
      if ((this.sessionMutations.get(sessionID) ?? 0) > version) continue;
      if (!activeSessionIDs.has(sessionID) && !this.stopped.has(sessionID))
        this.waiting.set(sessionID, null);
    }
    for (const [sessionID, endedAt] of this.waiting) {
      if ((this.sessionMutations.get(sessionID) ?? 0) > version) continue;
      if (activeSessionIDs.has(sessionID)) {
        this.waiting.delete(sessionID);
      } else if (!running.has(sessionID)) {
        // Recover missed continuation events and server restarts without flashing Worked
        // during the normal shell-exit -> notification -> execution-start handoff.
        if (endedAt === null) this.waiting.set(sessionID, Date.now());
        else if (Date.now() - endedAt >= 2_000) this.waiting.delete(sessionID);
      }
    }
    return [...this.waiting.keys()];
  }

  clearSession(sessionID: string): void {
    this.sessionMutations.set(sessionID, ++this.revision);
    this.waiting.delete(sessionID);
    this.stopped.add(sessionID);
  }

  reset(): void {
    this.shells.clear();
    this.mutations.clear();
    this.sessionMutations.clear();
    this.waiting.clear();
    this.stopped.clear();
    this.revision = 0;
  }
}
