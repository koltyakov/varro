import type { JobInfo, ShellInfo } from '@opencode/client';
import { BACKGROUND_COMMAND_SUMMARY_CHARS } from '../shared/background-process';
import { asRecord, isNumber, isString, type UnknownRecord } from '../shared/type-utils';

type PendingBackgroundWork = { directory?: string; startedAt?: number; command?: string };

/** Background tools settle before their jobs and automatic follow-up turns do. */
export class OpenCodeV2BackgroundWork {
  private readonly shells = new Map<
    string,
    {
      sessionID: string;
      directory?: string;
      startedAt?: number;
      command?: string;
      service?: boolean;
    }
  >();
  private readonly mutations = new Map<string, number>();
  private readonly sessionMutations = new Map<string, number>();
  private readonly waiting = new Map<
    string,
    { directory?: string; endedAt: number | null; command?: string }
  >();
  private readonly stoppedSessions = new Set<string>();
  private readonly jobs = new Map<
    string,
    {
      directory?: string;
      version: number;
      items: readonly JobInfo[];
      serviceIDs: ReadonlySet<string>;
    }
  >();
  private readonly snapshots = new Map<string | undefined, number>();
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
          service: this.shells.get(info.id)?.service,
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
        if (waiting && !shell?.service && this.shellIDs(sessionID).length === 0) {
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
      const pending = this.pending(data.sessionID)[0];
      if (pending && !this.stoppedSessions.has(data.sessionID))
        this.waiting.set(data.sessionID, {
          directory: pending.directory,
          endedAt: null,
          command: pending.command,
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
  hasShell(id: string): boolean {
    return this.shells.has(id);
  }

  shellIDs(sessionID: string): string[] {
    return [...this.shells].flatMap(([id, shell]) =>
      shell.sessionID === sessionID && !shell.service ? [id] : []
    );
  }

  setService(id: string, service: boolean): void {
    const shell = this.shells.get(id);
    if (!shell) return;
    shell.service = service;
    this.mutations.set(id, ++this.revision);
    this.sessionMutations.set(shell.sessionID, this.revision);
    for (const [sessionID, jobs] of this.jobs) {
      if (!jobs.items.some((job) => job.kind === 'shell' && job.shellID === id)) continue;
      const serviceIDs = new Set(jobs.serviceIDs);
      if (service) serviceIDs.add(id);
      else serviceIDs.delete(id);
      jobs.serviceIDs = serviceIDs;
      if (this.pending(sessionID).length === 0) this.waiting.delete(sessionID);
    }
    if (service && this.pending(shell.sessionID).length === 0) this.waiting.delete(shell.sessionID);
  }

  serviceCount(sessionID: string): number {
    return [...this.shells.values()].filter(
      (shell) => shell.sessionID === sessionID && shell.service
    ).length;
  }

  serviceSessionIDs(): string[] {
    return [
      ...new Set(
        [...this.shells.values()].filter((shell) => shell.service).map((shell) => shell.sessionID)
      ),
    ];
  }

  startedAt(sessionID: string): number | undefined {
    const starts = this.pending(sessionID).flatMap((work) =>
      work.startedAt !== undefined ? [work.startedAt] : []
    );
    return starts.length > 0 ? Math.min(...starts) : undefined;
  }

  command(sessionID: string): string | undefined {
    return (
      this.pending(sessionID).find((work) => work.command)?.command ??
      this.waiting.get(sessionID)?.command
    );
  }

  snapshotVersion(): number {
    return ++this.revision;
  }

  reconcile(
    shells: ShellInfo[],
    activeSessionIDs: ReadonlySet<string>,
    directory: string | undefined,
    version: number,
    serviceIDs: ReadonlySet<string> = new Set(),
    jobs?: ReadonlyMap<string, readonly JobInfo[]>
  ): string[] {
    if ((this.snapshots.get(directory) ?? 0) > version) return [...this.waiting.keys()];
    this.snapshots.set(directory, version);
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
                  service: serviceIDs.has(shell.id),
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
    const sessionIDs = new Set([
      ...[...this.shells.values()]
        .filter((shell) => shell.directory === directory)
        .map((shell) => shell.sessionID),
      ...[...this.jobs].filter(([, value]) => value.directory === directory).map(([id]) => id),
      ...[...this.waiting].filter(([, value]) => value.directory === directory).map(([id]) => id),
      ...(jobs?.keys() ?? []),
    ]);
    for (const sessionID of sessionIDs) {
      if (jobs) {
        this.jobs.set(sessionID, {
          directory,
          version,
          items: jobs.get(sessionID) ?? [],
          serviceIDs,
        });
      } else this.jobs.delete(sessionID);
    }
    // A completed but unconsumed native job still has a notification to deliver.
    // Restore it and descendant work after reload; an idle model is not a finished task.
    for (const sessionID of sessionIDs) {
      const pending = this.pending(sessionID)[0];
      if (
        !pending ||
        (this.sessionMutations.get(sessionID) ?? 0) > version ||
        activeSessionIDs.has(sessionID) ||
        this.stoppedSessions.has(sessionID)
      )
        continue;
      this.waiting.set(sessionID, {
        directory,
        endedAt: null,
        command: this.command(sessionID),
      });
    }
    for (const [sessionID, waiting] of this.waiting) {
      if (waiting.directory !== directory) continue;
      if ((this.sessionMutations.get(sessionID) ?? 0) > version) continue;
      if (activeSessionIDs.has(sessionID)) {
        this.waiting.delete(sessionID);
      } else if (this.pending(sessionID).length === 0) {
        // Recover missed continuation events and server restarts without flashing Worked
        // during the normal shell-exit -> notification -> execution-start handoff.
        if (waiting.endedAt === null) waiting.endedAt = Date.now();
        else if (Date.now() - waiting.endedAt >= 2_000) this.waiting.delete(sessionID);
      }
    }
    return [...this.waiting.keys()];
  }

  private pending(sessionID: string): PendingBackgroundWork[] {
    const native = this.jobs.get(sessionID);
    const shells = [...this.shells].flatMap(([id, shell]) =>
      shell.sessionID === sessionID &&
      !shell.service &&
      (!native ||
        ((this.mutations.get(id) ?? 0) > native.version &&
          !native.items.some((job) => job.kind === 'shell' && job.shellID === id)))
        ? [shell]
        : []
    );
    if (!native) return shells;
    return [
      ...native.items.flatMap<PendingBackgroundWork>((job) => {
        if (job.status === 'cancelled') return [];
        if (job.kind === 'shell') {
          if (native.serviceIDs.has(job.shellID)) return [];
          if ((this.mutations.get(job.shellID) ?? 0) > native.version) {
            const shell = this.shells.get(job.shellID);
            return shell && !shell.service ? [{ ...shell, directory: native.directory }] : [];
          }
        }
        return [
          {
            directory: native.directory,
            startedAt: job.time.started,
            command: summarizeCommand(
              job.kind === 'shell'
                ? job.command
                : (job.title ?? (job.kind === 'subagent' ? job.description : job.path))
            ),
          },
        ];
      }),
      ...shells,
    ];
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
    this.jobs.clear();
    this.snapshots.clear();
    this.revision = 0;
  }
}

function summarizeCommand(command: string): string {
  return command.slice(0, BACKGROUND_COMMAND_SUMMARY_CHARS).replace(/\s+/g, ' ').trim();
}
