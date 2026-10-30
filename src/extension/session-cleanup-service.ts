/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Decode server responses at the cleanup boundary before allowing deletion. */
import { lstat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { asRecord } from '../shared/type-utils';
import { isMissingWorkspaceDirectoryMessage } from '../shared/workspace-directory-error';
import type { OpenCodeServer } from './server';
import { acquireFileLock } from './file-lock';
import { SessionCleanupProgress } from './session-cleanup-progress';
import { logger } from './logger';
import { usageDatabasePaths } from './usage-database-paths';
import {
  SessionTranscriptArchive,
  sessionTranscriptArchivePath,
  type TranscriptArchiveSession,
} from './session-transcript-archive';
import {
  archiveSessionUsage,
  cleanupLegacySessionRecords,
  finishUsageCleanup,
  readPendingUsageCleanup,
  readLegacyCleanupSessions,
  readUsageCleanupArtifacts,
  usageCleanupArtifacts,
  type UsageArchiveSession,
  type LegacyCleanupSession,
} from './usage-report-service';

type CleanupSession = TranscriptArchiveSession;
type CleanupServer = Pick<OpenCodeServer, 'request' | 'isAttachOnly' | 'apiVersion'> &
  Partial<Pick<OpenCodeServer, 'withStoppedServer'>>;
const PAGE_LIMIT = 1_000;
const SHOW_DETAILS = 'Show details';

class SessionCleanupStoppedError extends Error {}

export class SessionCleanupService {
  constructor(
    private readonly server: CleanupServer,
    private readonly ensureServerStarted: () => Promise<string | void>
  ) {}

  async run(): Promise<void> {
    try {
      if (this.server.isAttachOnly) {
        throw new Error(
          'Session cleanup must run on the local OpenCode server host, not in attach-only mode.'
        );
      }
      const input = await vscode.window.showInputBox({
        title: 'Delete old OpenCode sessions',
        prompt:
          'How many months of sessions should be kept? Uses last activity across all projects.',
        value: '6',
        validateInput: (value) =>
          /^[1-9]\d*$/.test(value) && Number(value) <= 1_200
            ? undefined
            : 'Enter a whole number of months from 1 to 1200.',
      });
      if (input === undefined) return;
      if (!/^[1-9]\d*$/.test(input) || Number(input) > 1_200)
        throw new Error('Invalid retention period.');
      const transcript = await vscode.window.showQuickPick(
        [
          {
            label: 'Yes, preserve transcripts',
            description:
              'Keep parent conversation prompts and final responses. Subagent transcripts are omitted.',
            preserve: true,
          },
          {
            label: 'No, preserve statistics only',
            description: 'Delete conversation content. Usage statistics are still preserved.',
            preserve: false,
          },
        ],
        {
          title: 'Delete old OpenCode sessions: preserve transcripts?',
          placeHolder: 'Should a trimmed transcript be preserved before deletion?',
          ignoreFocusOut: true,
        }
      );
      if (!transcript) return;
      const transcriptNote = transcript.preserve
        ? ` Trimmed parent conversations will be saved to ${sessionTranscriptArchivePath()}. Subagent transcripts, attachment bytes, tools, and reasoning are not kept.`
        : ' Conversation content will not be preserved.';
      const cutoff = retentionCutoff(Number(input));
      await this.ensureServerStarted();
      const release = await acquireFileLock(`${usageDatabasePaths().archivePath}.cleanup.lock`);
      try {
        const sessions = await this.listSessions();
        const legacy =
          this.server.apiVersion === 2 ? await readLegacyCleanupSessions(sessions) : [];
        const legacyCount = legacy.filter((session) => session.updated < cutoff).length;
        const candidates = [...sessions, ...legacy].filter((session) => session.updated < cutoff);
        const choice = await vscode.window.showWarningMessage(
          `Permanently delete up to ${candidates.length.toLocaleString()} OpenCode session records last touched before ${new Date(cutoff).toLocaleDateString()} across ALL projects, including ${legacyCount.toLocaleString()} legacy V1 records? Usage statistics will be archived first.${transcriptNote} Active sessions and trees with newer children are kept. Session-owned temporary files will be removed; original attachments and code files will not be deleted.${legacyCount ? ' Legacy cleanup stops and restarts OpenCode and requires all work to be idle. Close other OpenCode clients and back up your data first.' : ''}`,
          { modal: true },
          'Delete old sessions'
        );
        if (choice !== 'Delete old sessions') return;
        logger.info(
          `Session cleanup started: ${candidates.length.toLocaleString()} eligible sessions across all projects, last active before ${new Date(cutoff).toISOString().slice(0, 10)}.`
        );
        logger.info(`Usage archive: ${usageDatabasePaths().archivePath}`);
        if (transcript.preserve)
          logger.info(`Transcript archive: ${sessionTranscriptArchivePath()}`);
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'OpenCode cleanup',
            cancellable: true,
          },
          (progress, token) =>
            this.cleanup(sessions, legacy, cutoff, transcript.preserve, progress, token)
        );
        const deleted = result.deleted.toLocaleString();
        const deletedSessions = `${deleted} ${result.deleted === 1 ? 'session' : 'sessions'}`;
        const remaining = (candidates.length - result.deleted).toLocaleString();
        const message = result.cancelled
          ? `Cleanup cancelled. ${deletedSessions} deleted; ${remaining} left unchanged. Unfinished work can be resumed.`
          : `Cleanup complete. ${deletedSessions} deleted; ${remaining} kept. ${transcript.preserve ? 'Usage and transcripts saved.' : 'Usage statistics saved.'}`;
        if ((await vscode.window.showInformationMessage(message, SHOW_DETAILS)) === SHOW_DETAILS)
          logger.show();
      } finally {
        await release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof SessionCleanupStoppedError))
        logger.error(`Cleanup could not start: ${message}`);
      if (
        (await vscode.window.showErrorMessage(
          error instanceof SessionCleanupStoppedError
            ? message
            : `Cleanup could not start. ${message}`,
          SHOW_DETAILS
        )) === SHOW_DETAILS
      )
        logger.show();
    }
  }

  private async cleanup(
    sessions: CleanupSession[],
    legacy: LegacyCleanupSession[],
    cutoff: number,
    preserveTranscript: boolean,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken
  ): Promise<{ deleted: number; cancelled: boolean }> {
    const run = new SessionCleanupProgress(
      progress,
      token,
      [...sessions, ...legacy].filter((session) => session.updated < cutoff).length
    );
    try {
      const retained = new Map(sessions.map((session) => [session.id, session]));
      const legacyRemaining = new Set(legacy.map((session) => session.id));
      const children = new Map<string, CleanupSession[]>();
      const checked = new Set<string>();
      const markChecked = (id: string) => {
        checked.add(id);
        run.checked = checked.size;
      };
      for (const session of sessions) {
        if (!session.parentID) continue;
        const siblings = children.get(session.parentID) ?? [];
        siblings.push(session);
        children.set(session.parentID, siblings);
      }
      // Recovery and newly confirmed deletions share one final reference scan.
      // Do not block the first deletion on files left by earlier runs.
      const pending = (await readPendingUsageCleanup(run.signal)).filter(
        (session) => !retained.has(session.id) && !legacyRemaining.has(session.id)
      );
      const files = new Map(pending.map((session) => [session.id, session]));
      for (const session of sessions.toSorted(
        (left, right) => left.updated - right.updated || left.id.localeCompare(right.id)
      )) {
        if (token.isCancellationRequested) break;
        if (session.updated >= cutoff || !retained.has(session.id)) continue;
        const tree = collectTree(session, retained, children);
        if (tree.some((entry) => entry.updated >= cutoff)) {
          run.keep(session.id, 'tree includes newer sessions');
          markChecked(session.id);
          continue;
        }
        run.setPhase(
          `Validating ${session.id}, ${tree.length} sessions, oldest activity ${new Date(session.updated).toLocaleDateString()}`
        );
        if (!(await this.unchangedAndIdle(tree, preserveTranscript, run))) {
          markChecked(session.id);
          continue;
        }
        await archiveSessionUsage(
          tree,
          (message) => run.setPhase(message, 'Saving usage statistics'),
          run.signal
        );
        if (token.isCancellationRequested) break;
        if (preserveTranscript) {
          run.setPhase(
            `Saving trimmed transcripts for ${tree.length} sessions`,
            'Saving transcripts'
          );
          await new SessionTranscriptArchive(this.server).archive(tree, {
            signal: run.signal,
            onProgress: (message) => run.setPhase(message, 'Saving transcripts'),
          });
        }
        if (token.isCancellationRequested) break;
        if (!(await this.unchangedAndIdle(tree, preserveTranscript, run))) {
          markChecked(session.id);
          continue;
        }
        if (token.isCancellationRequested) break;
        run.deleting = true;
        run.setPhase(
          `Deleting archived tree ${session.id}, ${tree.length} sessions`,
          'Waiting for deletion'
        );
        const response = await this.server.request('DELETE', this.sessionPath(session), undefined, {
          unscoped: true,
        });
        if (response === false) throw new Error(`OpenCode refused to delete ${session.id}.`);
        // Do not treat a completed request as proof that deletion succeeded.
        for (const entry of tree) await this.confirmDeleted(entry, run);
        for (const entry of tree) {
          retained.delete(entry.id);
          run.deleted += 1;
          markChecked(entry.id);
          if (!legacyRemaining.has(entry.id)) files.set(entry.id, entry);
        }
        run.deleting = false;
      }
      if (legacy.length && !token.isCancellationRequested) {
        const legacyMap = new Map(legacy.map((session) => [session.id, session]));
        const legacyChildren = new Map<string, CleanupSession[]>();
        for (const session of legacy)
          if (session.parentID) {
            const siblings = legacyChildren.get(session.parentID) ?? [];
            siblings.push(session);
            legacyChildren.set(session.parentID, siblings);
          }
        const eligible: LegacyCleanupSession[] = [];
        for (const session of legacy) {
          if (session.updated >= cutoff) continue;
          if (
            collectTree(session, legacyMap, legacyChildren).some((entry) => entry.updated >= cutoff)
          ) {
            run.keep(`V1 ${session.id}`, 'tree includes newer sessions');
            markChecked(`v1:${session.id}`);
          } else eligible.push(session);
        }
        if (eligible.length) {
          if (!this.server.withStoppedServer)
            throw new Error('Verified offline maintenance is required to clean legacy V1 history.');
          run.setPhase(
            `Preparing offline cleanup of ${eligible.length.toLocaleString()} legacy V1 records`,
            'Preparing legacy cleanup'
          );
          await this.server.withStoppedServer(async () => {
            const deleted = await cleanupLegacySessionRecords(eligible, cutoff, {
              signal: run.signal,
              onProgress: (message) => run.setPhase(message, 'Saving legacy usage and timing'),
              prepared: async () => {
                if (preserveTranscript)
                  await new SessionTranscriptArchive(this.server).archive(eligible, {
                    signal: run.signal,
                    onProgress: (message) => run.setPhase(message, 'Saving legacy transcripts'),
                  });
                run.signal.throwIfAborted();
              },
              committing: () => {
                run.deleting = true;
                run.setPhase('Deleting archived legacy V1 records', 'Finishing legacy deletion');
              },
            });
            run.deleted += deleted;
            for (const session of eligible) {
              markChecked(`v1:${session.id}`);
              legacyRemaining.delete(session.id);
              if (!retained.has(session.id)) files.set(session.id, session);
            }
            run.deleting = false;
          });
        }
      }
      if (files.size && !token.isCancellationRequested) {
        const journal = new Map(
          (await readPendingUsageCleanup(run.signal)).map((session) => [session.id, session])
        );
        for (const [id, session] of files)
          files.set(id, { ...session, directories: journal.get(id)?.directories });
        run.startReferenceCheck(files.size);
        const paths = await readUsageCleanupArtifacts(
          [...files.keys()],
          (message, processed) => run.referenceProgress(message, processed),
          run.signal
        );
        run.startFileCleanup();
        let index = 0;
        for (const session of files.values()) {
          run.signal.throwIfAborted();
          run.setPhase(`Cleaning files ${++index}/${files.size} for ${session.id}`);
          await this.cleanArtifacts(session, run, paths.get(session.id));
          run.recovered++;
        }
      }
      run.finish(token.isCancellationRequested ? 'cancelled' : 'complete');
      return {
        deleted: run.deleted,
        cancelled: token.isCancellationRequested,
      };
    } catch (error) {
      if (run.signal.aborted && !run.deleting) {
        run.finish('cancelled');
        return { deleted: run.deleted, cancelled: true };
      }
      run.finish('stopped', error instanceof Error ? error : new Error(String(error)));
      throw new SessionCleanupStoppedError(
        `Cleanup stopped while ${run.activity}. ${run.deleted === 0 ? 'No sessions were deleted.' : `${run.deleted.toLocaleString()} ${run.deleted === 1 ? 'session' : 'sessions'} deleted; saved archives are safe.`} Unfinished work can be resumed.`,
        { cause: error }
      );
    } finally {
      run.dispose();
    }
  }

  private async unchangedAndIdle(
    tree: CleanupSession[],
    preserveTranscript: boolean,
    run?: SessionCleanupProgress
  ): Promise<boolean> {
    const keep = (reason: string) => {
      run?.keep(tree[0]!.id, reason);
      return false;
    };
    let directories = [...new Set(tree.map((session) => session.directory))];
    if (this.server.apiVersion === 2) {
      const response = asRecord(
        await this.read('/api/session/active', `Checking global activity for ${tree[0]!.id}`, run)
      );
      const active = asRecord(response?.data);
      if (!active) throw new Error('OpenCode returned malformed global session activity.');
      if (tree.some((session) => Object.hasOwn(active, session.id)))
        return keep('tree has an active session');
      const locations = await this.read(
        '/api/debug/location',
        'Listing loaded locations for shell checks',
        run
      );
      if (!Array.isArray(locations))
        throw new Error('OpenCode returned malformed loaded locations.');
      // Shells belong to retained location services, not session rows. Only query
      // existing service graphs: historical directories must not be booted to delete history.
      // Check every loaded graph so moved sessions keep their older background services.
      directories = [
        ...new Set(
          locations.map((value) => {
            const location = asRecord(value);
            if (typeof location?.directory !== 'string' || !isAbsolute(location.directory))
              throw new Error('OpenCode returned a malformed loaded location.');
            return location.directory;
          })
        ),
      ];
    }
    for (const [index, directory] of directories.entries()) {
      const statuses = asRecord(
        await this.read(
          `/session/status?directory=${encodeURIComponent(directory)}`,
          `Checking shells ${index + 1}/${directories.length} for ${tree[0]!.id}`,
          run
        )
      );
      if (!statuses) throw new Error('OpenCode returned malformed session activity.');
      if (
        tree.some((session) => {
          const status = asRecord(statuses[session.id]);
          return (
            Object.hasOwn(statuses, session.id) &&
            (status?.type !== 'idle' || Number(status.backgroundServices ?? 0) > 0)
          );
        })
      )
        return keep('tree has a running shell or background service');
    }
    for (const session of tree) {
      if (preserveTranscript && this.server.apiVersion === 2) {
        const response = asRecord(
          await this.read(
            `/api/session/${encodeURIComponent(session.id)}/inbox`,
            `Checking queued inputs for ${session.id}`,
            run
          )
        );
        if (!Array.isArray(response?.data))
          throw new Error('OpenCode returned a malformed transcript inbox.');
        if (response.data.length) return keep(`${session.id} has queued inputs`);
      }
      const current = decodeSession(
        await this.read(this.sessionPath(session), `Checking metadata for ${session.id}`, run)
      );
      if (
        current.updated !== session.updated ||
        current.directory !== session.directory ||
        current.parentID !== session.parentID
      )
        return keep(`${session.id} metadata changed`);
      const children = await this.read(
        this.sessionPath(session, '/children'),
        `Checking child sessions for ${session.id}`,
        run
      );
      if (!Array.isArray(children) || children.length >= PAGE_LIMIT) {
        throw new Error(`Cannot safely verify all child sessions for ${session.id}.`);
      }
      const expected = tree.filter((entry) => entry.parentID === session.id);
      if (
        children.length !== expected.length ||
        children.some((value) => {
          const child = decodeSession(value);
          return !expected.some(
            (entry) => entry.id === child.id && entry.updated === child.updated
          );
        })
      )
        return keep(`${session.id} child membership changed`);
    }
    return true;
  }

  private async listSessions(): Promise<CleanupSession[]> {
    const sessions = new Map<string, CleanupSession>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ archived: 'true', limit: String(PAGE_LIMIT) });
      if (cursor) query.set('cursor', cursor);
      const response = await this.server.request(
        'GET',
        `/experimental/session?${query}`,
        undefined,
        { unscoped: true, captureNextCursor: true }
      );
      const page = asRecord(response);
      const data: unknown = Array.isArray(response) ? response : page?.data;
      if (!Array.isArray(data))
        throw new Error('OpenCode returned a malformed global session list.');
      for (const value of data) {
        const session = decodeSession(value);
        sessions.set(session.id, session);
      }
      const nextCursor = page?.nextCursor;
      if (nextCursor !== undefined && typeof nextCursor !== 'string')
        throw new Error('Invalid session pagination cursor.');
      cursor = nextCursor;
      if (cursor && cursors.has(cursor))
        throw new Error('OpenCode repeated a session pagination cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...sessions.values()];
  }

  private async cleanArtifacts(
    session: UsageArchiveSession,
    run?: SessionCleanupProgress,
    checkedPaths?: string[]
  ): Promise<void> {
    run?.setPhase(`Checking owned files for ${session.id}`);
    const signal = run && !run.deleting ? run.signal : undefined;
    const paths =
      checkedPaths ??
      (await usageCleanupArtifacts(session.id, (message) => run?.setPhase(message), signal));
    for (const [index, path] of paths.entries()) {
      signal?.throwIfAborted();
      run?.setPhase(`Removing owned file ${index + 1}/${paths.length} for ${session.id}`);
      const directories = session.directories ?? [session.directory];
      const toolRoot = join(resolve(usageDatabasePaths().dataDirectory), 'tool-output');
      const target = resolve(path);
      const attachmentDirectory = directories.find(
        (directory) => target === join(resolve(directory), '.opencode', 'attachments', session.id)
      );
      const diffPath = join(
        resolve(usageDatabasePaths().dataDirectory),
        'storage',
        'session_diff',
        `${session.id}.json`
      );
      const dropRoot = join(tmpdir(), 'varro-drops');
      const temporaryDrop =
        dirname(dirname(target)) === dropRoot &&
        /^drop-[a-zA-Z0-9_-]+$/.test(basename(dirname(target))) &&
        /^\d+-[a-f0-9]{32}-.+$/.test(basename(target));
      const root =
        attachmentDirectory !== undefined
          ? resolve(attachmentDirectory)
          : target === diffPath
            ? resolve(usageDatabasePaths().dataDirectory)
            : dirname(target) === toolRoot && /^tool_[a-zA-Z0-9._-]+$/.test(basename(target))
              ? dirname(toolRoot)
              : temporaryDrop
                ? tmpdir()
                : null;
      if (!root) throw new Error(`Refusing to remove a non-session artifact: ${path}`);
      const parts = relative(root, target).split(sep);
      if (parts.includes('..') || isAbsolute(relative(root, target)))
        throw new Error('Invalid artifact path.');
      let current = root;
      let missing = false;
      for (const part of parts) {
        current = join(current, part);
        try {
          if ((await lstat(current)).isSymbolicLink())
            throw new Error(`Refusing to follow an artifact symlink: ${current}`);
        } catch (error) {
          if (asRecord(error)?.code !== 'ENOENT') throw error;
          missing = true;
          break;
        }
      }
      if (!missing) {
        if (temporaryDrop) {
          const markerPath = join(dirname(target), '.varro-owner.json');
          const metadata = await lstat(markerPath);
          if (!metadata.isFile() || metadata.isSymbolicLink())
            throw new Error('Invalid temporary attachment owner marker.');
          const marker = asRecord(JSON.parse(await readFile(markerPath, 'utf8')));
          if (
            marker?.version !== 1 ||
            typeof marker.pid !== 'number' ||
            !Number.isSafeInteger(marker.pid) ||
            marker.pid <= 0 ||
            typeof marker.createdAt !== 'number' ||
            !Number.isFinite(marker.createdAt) ||
            marker.createdAt < 0
          )
            throw new Error('Invalid temporary attachment owner marker.');
        }
        await rm(target, { recursive: attachmentDirectory !== undefined, force: true });
      }
    }
    run?.setPhase(`Saving file cleanup journal for ${session.id}`);
    await finishUsageCleanup(session.id, paths, signal);
  }

  private async confirmDeleted(
    session: UsageArchiveSession,
    run?: SessionCleanupProgress
  ): Promise<void> {
    try {
      await this.read(this.sessionPath(session), `Confirming deletion of ${session.id}`, run);
    } catch (error) {
      if (
        error instanceof Error &&
        /^404\b/.test(error.message) &&
        !isMissingWorkspaceDirectoryMessage(error.message)
      )
        return;
      throw error;
    }
    throw new Error(`OpenCode did not confirm deletion of ${session.id}.`);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Each cleanup route validates its API reply before permitting deletion.
  private read(path: string, message: string, run?: SessionCleanupProgress): Promise<unknown> {
    return run
      ? run.read(message, (signal) =>
          this.server.request('GET', path, undefined, { unscoped: true, signal })
        )
      : this.server.request('GET', path, undefined, { unscoped: true });
  }

  private sessionPath(session: UsageArchiveSession, suffix = ''): string {
    const path = `/session/${encodeURIComponent(session.id)}${suffix}`;
    return this.server.apiVersion === 2
      ? path
      : `${path}?directory=${encodeURIComponent(session.directory)}`;
  }
}

function retentionCutoff(months: number, now = new Date()): number {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const endOfMonth = new Date(cutoff);
  endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1, 0);
  cutoff.setUTCDate(Math.min(day, endOfMonth.getUTCDate()));
  return cutoff.getTime();
}

function decodeSession(value: unknown): CleanupSession {
  const session = asRecord(value);
  const updated = asRecord(session?.time)?.updated;
  if (
    typeof session?.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(session.id) ||
    typeof session.directory !== 'string' ||
    !isAbsolute(session.directory) ||
    typeof updated !== 'number' ||
    !Number.isFinite(updated) ||
    updated < 0 ||
    (session.parentID !== undefined && typeof session.parentID !== 'string')
  ) {
    throw new Error(
      'OpenCode returned malformed session metadata. No further sessions were deleted.'
    );
  }
  const created = asRecord(session.time)?.created;
  const identity = asRecord(asRecord(session.metadata)?.varroLegacyImport)?.sourceSessionID;
  return {
    id: session.id,
    directory: session.directory,
    updated,
    parentID: session.parentID,
    title: typeof session.title === 'string' ? session.title : undefined,
    created:
      typeof created === 'number' && Number.isFinite(created) && created >= 0 ? created : undefined,
    identity: typeof identity === 'string' ? identity : undefined,
  };
}

function collectTree(
  root: CleanupSession,
  sessions: Map<string, CleanupSession>,
  children: Map<string, CleanupSession[]>
): CleanupSession[] {
  const tree = [root];
  const seen = new Set([root.id]);
  for (let index = 0; index < tree.length; index += 1) {
    for (const session of children.get(tree[index]!.id) ?? []) {
      if (!sessions.has(session.id)) continue;
      if (seen.has(session.id)) throw new Error('OpenCode returned a cyclic session tree.');
      seen.add(session.id);
      tree.push(session);
    }
  }
  return tree;
}
