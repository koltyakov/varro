import type { ShellInfo } from '@opencode/client';
import { BACKGROUND_COMMAND_SUMMARY_CHARS } from '../shared/background-process';
import { asRecord, isNumber, isString, type UnknownRecord } from '../shared/type-utils';

/** Shell calls settle before their background processes and automatic follow-up turns do. */
export class OpenCodeV2BackgroundWork {
  private readonly shells = new Map<
    string,
    { sessionID: string; directory?: string; startedAt?: number; command?: string }
  >();
  private readonly mutations = new Map<string, number>();
  private readonly sessionMutations = new Map<string, number>();
  private readonly waiting = new Map<
    string,
    { directory?: string; endedAt: number | null; command?: string }
  >();
  private readonly stoppedSessions = new Set<string>();
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
          command: isString(info.command) ? summarizeCommand(info.command) : undefined,
        });
        this.mutations.set(info.id, ++this.revision);
        this.sessionMutations.set(sessionID, this.revision);
      }
    }
    if ((type === 'shell.exited' || type === 'shell.deleted') && isString(data.id)) {
      const shell = this.shells.get(data.id);
      const sessionID = shell?.sessionID;
      this.shells.delete(data.id);
      this.mutations.set(data.id, ++this.revision);
      // Keep Waiting through the gap before the completion notification resumes the model.
      if (sessionID) {
        this.sessionMutations.set(sessionID, this.revision);
        const waiting = this.waiting.get(sessionID);
        if (waiting && this.shellIDs(sessionID).length === 0) {
          waiting.endedAt = Date.now();
          waiting.command = shell?.command ?? waiting.command;
        }
      }
    }
    if (!isString(data.sessionID)) return;
    if (type.startsWith('session.execution.') || type.startsWith('session.step.'))
      this.sessionMutations.set(data.sessionID, ++this.revision);
    if (
      (type === 'session.step.ended' && data.finish === 'stop') ||
      type === 'session.execution.succeeded'
    ) {
      const pendingShell = [...this.shells.values()].find(
        (shell) => shell.sessionID === data.sessionID
      );
      if (pendingShell && !this.stoppedSessions.has(data.sessionID))
        this.waiting.set(data.sessionID, {
          directory: pendingShell.directory,
          endedAt: null,
          command: pendingShell.command,
        });
    }
    if (type === 'session.execution.started' || type === 'session.step.started')
      this.stoppedSessions.delete(data.sessionID);
    if (
      type === 'session.step.started' ||
      type === 'session.execution.failed' ||
      type === 'session.execution.interrupted' ||
      type === 'session.deleted'
    ) {
      this.waiting.delete(data.sessionID);
      if (type !== 'session.step.started') this.stoppedSessions.add(data.sessionID);
    }
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

  command(sessionID: string): string | undefined {
    return (
      [...this.shells.values()].find((shell) => shell.sessionID === sessionID && shell.command)
        ?.command ?? this.waiting.get(sessionID)?.command
    );
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
          ? [
              [
                shell.id,
                {
                  sessionID,
                  directory,
                  startedAt: shell.time.started,
                  command: summarizeCommand(shell.command),
                },
              ] as const,
            ]
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
    // Session-owned shells notify the model on exit, even after execution succeeds.
    // Restore that pending work after reload; an idle model is not a finished task.
    for (const shell of this.shells.values()) {
      if (
        shell.directory !== directory ||
        (this.sessionMutations.get(shell.sessionID) ?? 0) > version ||
        activeSessionIDs.has(shell.sessionID) ||
        this.stoppedSessions.has(shell.sessionID)
      )
        continue;
      this.waiting.set(shell.sessionID, {
        directory,
        endedAt: null,
        command: this.command(shell.sessionID),
      });
    }
    for (const [sessionID, waiting] of this.waiting) {
      if (waiting.directory !== directory) continue;
      if ((this.sessionMutations.get(sessionID) ?? 0) > version) continue;
      if (activeSessionIDs.has(sessionID)) {
        this.waiting.delete(sessionID);
      } else if (this.shellIDs(sessionID).length === 0) {
        // Recover missed continuation events and server restarts without flashing Worked
        // during the normal shell-exit -> notification -> execution-start handoff.
        if (waiting.endedAt === null) waiting.endedAt = Date.now();
        else if (Date.now() - waiting.endedAt >= 2_000) this.waiting.delete(sessionID);
      }
    }
    return [...this.waiting.keys()];
  }

  clearSession(sessionID: string): void {
    this.sessionMutations.set(sessionID, ++this.revision);
    this.waiting.delete(sessionID);
    this.stoppedSessions.add(sessionID);
  }

  reset(): void {
    this.shells.clear();
    this.mutations.clear();
    this.sessionMutations.clear();
    this.waiting.clear();
    this.stoppedSessions.clear();
    this.revision = 0;
  }
}

function summarizeCommand(command: string): string {
  return command.slice(0, BACKGROUND_COMMAND_SUMMARY_CHARS).replace(/\s+/g, ' ').trim();
}
