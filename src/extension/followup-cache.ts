/* oxlint-disable anti-slop/no-unknown-parameters -- Legacy workspace values and disk JSON are validated at this storage boundary. */
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Persistence } from '../shared/persistence';
import type { FollowupAction, FollowupSuggestionSet } from '../shared/followups';
import { EMPTY_FOLLOWUP_SUGGESTIONS, parseFollowupSuggestions } from '../shared/followups';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import { acquireFileLock } from './file-lock';
import { getVarroStateDirectory } from './varro-state-paths';

const STORAGE_KEY = 'varro.followupCache.v1';
const MAX_PRESENTATIONS = 512;
type Entry = {
  sessionKey: string;
  digest: string;
  dismissed: boolean;
  pendingSince?: number;
  suggestions: FollowupSuggestionSet;
};
type Entries = Record<string, Entry>;

/** Host-owned cache. Attempts, abstentions, failures, and dismissals never expire on a timer. */
export class FollowupCache {
  private queue: Promise<void> = Promise.resolve();
  private migration: Promise<void> | undefined;
  private readonly path: string;

  constructor(private readonly legacyPersistence?: Persistence) {
    this.path = join(getVarroStateDirectory('followups'), 'cache.json');
  }

  async get(key: string, digest: string): Promise<FollowupSuggestionSet | undefined> {
    const result = await this.getState(key, digest);
    return result === 'pending' ? EMPTY_FOLLOWUP_SUGGESTIONS : result;
  }

  async getState(
    key: string,
    digest: string
  ): Promise<FollowupSuggestionSet | 'pending' | undefined> {
    await this.migrate();
    const entry = (await this.read())[key];
    if (!entry) return undefined;
    if (
      entry.digest === digest &&
      !entry.dismissed &&
      entry.pendingSince !== undefined &&
      Date.now() - entry.pendingSince < 35_000
    )
      return 'pending';
    return entry.digest === digest && !entry.dismissed
      ? entry.suggestions
      : EMPTY_FOLLOWUP_SUGGESTIONS;
  }

  async claim(key: string, digest: string, sessionKey: string): Promise<boolean> {
    let claimed = false;
    await this.change((entries) => {
      if (entries[key]) return false;
      entries[key] = {
        sessionKey,
        digest,
        dismissed: false,
        pendingSince: Date.now(),
        suggestions: EMPTY_FOLLOWUP_SUGGESTIONS,
      };
      claimed = true;
      return true;
    });
    return claimed;
  }

  complete(key: string, digest: string, suggestions: FollowupSuggestionSet): Promise<void> {
    return this.change((entries) => {
      const entry = entries[key];
      if (!entry || entry.digest !== digest || entry.dismissed) return false;
      entry.suggestions = suggestions;
      delete entry.pendingSince;
      return true;
    });
  }

  dismiss(key: string, digest: string): Promise<void> {
    return this.change((entries) => {
      const entry = entries[key];
      if (!entry || entry.digest !== digest || entry.dismissed) return false;
      entry.dismissed = true;
      delete entry.pendingSince;
      entry.suggestions = EMPTY_FOLLOWUP_SUGGESTIONS;
      return true;
    });
  }

  async linkSession(
    key: string,
    digest: string,
    action: FollowupAction & { sessionId: string }
  ): Promise<boolean> {
    if (!/^[\w-]{1,200}$/.test(action.sessionId)) throw new Error('Invalid follow-up session ID');
    let linked = false;
    await this.change((entries) => {
      const entry = entries[key];
      if (!entry || entry.digest !== digest || entry.dismissed) return false;
      const stored = entry.suggestions.actions.find(
        (item) => item.title === action.title && item.prompt === action.prompt
      );
      if (!stored || (stored.sessionId && stored.sessionId !== action.sessionId)) return false;
      linked = true;
      if (stored.sessionId === action.sessionId) return false;
      stored.sessionId = action.sessionId;
      return true;
    });
    return linked;
  }

  clearSession(sessionKey: string, exceptKey?: string): Promise<void> {
    return this.change((entries) => {
      let changed = false;
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.sessionKey !== sessionKey || key === exceptKey || entry.dismissed) continue;
        entry.dismissed = true;
        delete entry.pendingSince;
        entry.suggestions = EMPTY_FOLLOWUP_SUGGESTIONS;
        changed = true;
      }
      return changed;
    });
  }

  private change(update: (entries: Entries) => boolean): Promise<void> {
    return this.mutate(async (entries) => {
      const migrated = this.mergeLegacy(entries);
      if (update(entries) || migrated) await this.write(entries);
      await this.removeLegacy();
    });
  }

  private async migrate(): Promise<void> {
    if (this.legacyPersistence?.get<unknown>(STORAGE_KEY) === undefined) return;
    this.migration ??= this.change(() => false);
    try {
      await this.migration;
    } catch (error) {
      this.migration = undefined;
      throw error;
    }
  }

  private mergeLegacy(entries: Entries): boolean {
    const stored = this.legacyPersistence?.get<unknown>(STORAGE_KEY);
    if (stored === undefined) return false;
    if (!asRecord(stored)) throw new Error('Invalid legacy follow-up cache');
    const legacy = parseEntries(stored);
    let changed = false;
    for (const [key, entry] of Object.entries(legacy)) {
      const current = entries[key];
      if (!current) {
        entries[key] = entry;
        changed = true;
      } else if (
        !current.dismissed &&
        (entry.dismissed ||
          current.digest !== entry.digest ||
          current.sessionKey !== entry.sessionKey)
      ) {
        // A stale workspace must not revive dismissal, retirement, or conflicting source data.
        current.dismissed = true;
        current.suggestions = EMPTY_FOLLOWUP_SUGGESTIONS;
        changed = true;
      }
    }
    return changed;
  }

  private async removeLegacy(): Promise<void> {
    if (this.legacyPersistence?.get<unknown>(STORAGE_KEY) !== undefined)
      await this.legacyPersistence.remove(STORAGE_KEY);
  }

  private mutate(run: (entries: Entries) => Promise<void>): Promise<void> {
    const result = this.queue.then(async () => {
      const release = await acquireFileLock(`${this.path}.lock`);
      try {
        await run(await this.read());
      } finally {
        await release();
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<Entries> {
    try {
      const stored = asRecord(JSON.parse(await readFile(this.path, 'utf8')));
      if (stored?.version !== 1 || !asRecord(stored.entries))
        throw new Error('Invalid follow-up cache format');
      return parseEntries(stored.entries);
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return {};
      // Lost or unreadable admission must not silently permit another billed attempt.
      throw new Error('Could not read Varro follow-up cache', { cause: error });
    }
  }

  private async write(entries: Entries): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      // Bound generated text, not admission. Evicting admission could bill an old turn again.
      for (const [, entry] of Object.entries(entries).slice(0, -MAX_PRESENTATIONS)) {
        entry.dismissed = true;
        delete entry.pendingSince;
        entry.suggestions = EMPTY_FOLLOWUP_SUGGESTIONS;
      }
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          entries,
        }),
        { flag: 'wx', mode: 0o600 }
      );
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, this.path);
          break;
        } catch (error) {
          // Windows readers and antivirus can briefly deny replacement. Keep the lock and
          // the committed file intact; never unlink the destination to force a replacement.
          if (
            process.platform !== 'win32' ||
            !['EPERM', 'EACCES', 'EBUSY'].includes(String(asRecord(error)?.code)) ||
            attempt >= 7
          )
            throw error;
          await delay(Math.min(10 * 2 ** attempt, 200));
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function parseEntries(storedValue: unknown) {
  const stored = asRecord(storedValue);
  const entries: Entries = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    const entry = asRecord(value);
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !isString(entry?.digest) ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      !isString(entry.sessionKey) ||
      !/^[a-f0-9]{64}$/.test(entry.sessionKey)
    )
      throw new Error('Invalid follow-up admission record');
    try {
      const suggestions = parseFollowupSuggestions(JSON.stringify(entry.suggestions), {
        allowSessionId: true,
      });
      entries[key] = {
        sessionKey: entry.sessionKey,
        digest: entry.digest,
        dismissed: entry.dismissed === true,
        pendingSince: isNumber(entry.pendingSince) ? entry.pendingSince : undefined,
        suggestions: entry.dismissed === true ? EMPTY_FOLLOWUP_SUGGESTIONS : suggestions,
      };
    } catch {
      // Corrupt presentation must not erase the admission and allow another billed attempt.
      entries[key] = {
        sessionKey: entry.sessionKey,
        digest: entry.digest,
        dismissed: true,
        suggestions: EMPTY_FOLLOWUP_SUGGESTIONS,
      };
    }
  }
  return entries;
}
