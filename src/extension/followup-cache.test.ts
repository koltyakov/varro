/* oxlint-disable anti-slop/no-module-mocking -- Only atomic publication failures are injected; storage and cross-process locking use real isolated files. */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupCache } from './followup-cache';
import { EMPTY_FOLLOWUP_SUGGESTIONS } from '../shared/followups';
import type { FollowupSuggestionSet } from '../shared/followups';
import type { Persistence } from '../shared/persistence';
import { asRecord } from '../shared/type-utils';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const storageKey = 'varro.followupCache.v1';
const platform = process.platform;
const suggestions = {
  summary: 'The parser still needs a focused regression test.',
  actions: [{ title: 'Add a test', prompt: 'Add a parser regression test.' }],
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = hash('digest');
const sessionKey = hash('session');
const entry = (dismissed = false) => ({
  sessionKey,
  digest,
  dismissed,
  suggestions: dismissed ? EMPTY_FOLLOWUP_SUGGESTIONS : suggestions,
});
let directory: string;
let path: string;

type LegacyEntry = Omit<ReturnType<typeof entry>, 'suggestions'> & {
  suggestions: FollowupSuggestionSet | string;
};

function workspace(entries: Record<string, LegacyEntry>) {
  const values = new Map<string, unknown>([[storageKey, entries]]);
  const persistence: Persistence = {
    // SAFETY: This fixture supplies only the legacy cache snapshot requested by the decoder.
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: vi.fn((key, value) => {
      values.set(key, value);
    }),
    remove: vi.fn((key) => {
      values.delete(key);
    }),
  };
  return { values, persistence };
}

beforeEach(async () => {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(join(parent, 'followup-cache-'));
  vi.stubEnv('VARRO_TEST_STATE_ROOT', directory);
  path = join(directory, 'followups', 'cache.json');
  vi.mocked(rename).mockReset();
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('FollowupCache', () => {
  it('stores action session IDs in the existing JSON and restores them across cache instances', async () => {
    const cache = new FollowupCache();
    const key = hash('linked-turn');
    await cache.claim(key, digest, sessionKey);
    await cache.complete(key, digest, suggestions);
    const action = { ...suggestions.actions[0]!, sessionId: 'ses_fork-1' };
    expect(await cache.linkSession(key, digest, action)).toBe(true);
    const linked = { ...suggestions, actions: [action] };
    expect(await new FollowupCache().get(key, digest)).toEqual(linked);
    expect(JSON.parse(await readFile(path, 'utf8')).entries[key].suggestions).toEqual(linked);
    expect(await new FollowupCache().linkSession(key, digest, action)).toBe(true);
    expect(await cache.linkSession(key, digest, { ...action, sessionId: 'ses_other' })).toBe(false);
    expect(await new FollowupCache().get(key, digest)).toEqual(linked);
  });

  it('merges concurrent links on different actions without losing either session ID', async () => {
    const key = hash('parallel-links');
    const second = { title: 'Inspect parser', prompt: 'Inspect the reported parser issue.' };
    const cache = new FollowupCache();
    await cache.claim(key, digest, sessionKey);
    await cache.complete(key, digest, {
      ...suggestions,
      actions: [...suggestions.actions, second],
    });
    const linked = [
      { ...suggestions.actions[0]!, sessionId: 'ses_first' },
      { ...second, sessionId: 'ses_second' },
    ];
    expect(
      await Promise.all(
        linked.map((action) => new FollowupCache().linkSession(key, digest, action))
      )
    ).toEqual([true, true]);
    expect(await new FollowupCache().get(key, digest)).toEqual({ ...suggestions, actions: linked });
  });

  it('does not revive linked follow-ups retired by a new prompt', async () => {
    const cache = new FollowupCache();
    const key = hash('old-linked-turn');
    const action = { ...suggestions.actions[0]!, sessionId: 'ses_fork-1' };
    await cache.claim(key, digest, sessionKey);
    await cache.complete(key, digest, suggestions);
    expect(await cache.linkSession(key, hash('different-digest'), action)).toBe(false);
    expect(await cache.linkSession(key, digest, { ...action, prompt: 'Different action' })).toBe(
      false
    );
    expect(await cache.linkSession(key, digest, action)).toBe(true);
    await cache.clearSession(sessionKey);
    expect(await new FollowupCache().linkSession(key, digest, action)).toBe(false);
    expect(await new FollowupCache().get(key, digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await readFile(path, 'utf8')).not.toContain('ses_fork-1');
  });

  it('distinguishes a pending admission from a completed empty result across cache instances', async () => {
    const writer = new FollowupCache();
    const reader = new FollowupCache();
    const key = hash('pending-turn');
    await writer.claim(key, digest, sessionKey);
    expect(await reader.getState(key, digest)).toBe('pending');
    await writer.complete(key, digest, EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await reader.getState(key, digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await reader.claim(key, digest, sessionKey)).toBe(false);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries transient Windows %s replacement failures without losing dismissal',
    async (code) => {
      const cache = new FollowupCache();
      await cache.claim(hash('turn'), digest, sessionKey);
      await cache.complete(hash('turn'), digest, suggestions);
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
      let attempts = 0;
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (String(from).endsWith('.tmp') && ++attempts < 3)
          throw Object.assign(new Error('Windows sharing violation'), { code });
        await actual.rename(from, to);
      });
      await cache.dismiss(hash('turn'), digest);
      expect(attempts).toBe(3);
      expect(await new FollowupCache().get(hash('turn'), digest)).toEqual(
        EMPTY_FOLLOWUP_SUGGESTIONS
      );
      expect(await new FollowupCache().claim(hash('turn'), digest, sessionKey)).toBe(false);
      expect(await readFile(path, 'utf8')).not.toContain(suggestions.summary);
      expect(await readdir(join(directory, 'followups'))).toEqual(['cache.json']);
    }
  );

  it('bounds persistent Windows replacement failures and preserves the committed file and legacy data', async () => {
    const cache = new FollowupCache();
    await cache.claim(hash('turn'), digest, sessionKey);
    const committed = await readFile(path, 'utf8');
    const legacy = workspace({ [hash('imported')]: entry(true) });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    let attempts = 0;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith('.tmp')) {
        attempts++;
        throw Object.assign(new Error('Windows sharing violation'), { code: 'EPERM' });
      }
      await actual.rename(from, to);
    });
    await expect(
      new FollowupCache(legacy.persistence).get(hash('imported'), digest)
    ).rejects.toThrow('Windows sharing violation');
    expect(attempts).toBe(8);
    expect(await readFile(path, 'utf8')).toBe(committed);
    expect(legacy.values.has(storageKey)).toBe(true);
    expect(await readdir(join(directory, 'followups'))).toEqual(['cache.json']);
  });

  it.skipIf(platform !== 'win32')(
    'retries a real Windows handle that denies file replacement',
    async () => {
      const cache = new FollowupCache();
      await cache.claim(hash('turn'), digest, sessionKey);
      await cache.complete(hash('turn'), digest, suggestions);
      const startedAt = Date.now();
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          // Keep the script in one argument, independent of Windows command-line quoting.
          '-EncodedCommand',
          Buffer.from(
            `
      $ErrorActionPreference = 'Stop'
      [Console]::WriteLine('starting')
      [Console]::Out.Flush()
      $file = [System.IO.File]::Open($env:VARRO_FOLLOWUP_TEST_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
      try {
        [Console]::WriteLine('locked')
        [Console]::Out.Flush()
        [Console]::ReadLine() | Out-Null
      }
      finally { $file.Dispose() }
    `,
            'utf16le'
          ).toString('base64'),
        ],
        {
          env: { ...process.env, VARRO_FOLLOWUP_TEST_FILE: path },
          windowsHide: true,
          stdio: 'pipe',
          // Bound fixture startup and release independently of Vitest's deadline.
          timeout: 15_000,
          killSignal: 'SIGKILL',
        }
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let stdout = '';
      const diagnostics = () =>
        JSON.stringify({
          elapsedMs: Date.now() - startedAt,
          pid: child.pid,
          exitCode: child.exitCode,
          signal: child.signalCode,
          killed: child.killed,
          stdout,
          stderr,
        });
      const acquired = new Promise<void>((done, reject) => {
        child.once('error', reject);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.split(/\r?\n/).includes('locked')) done();
        });
        // close follows stdout/stderr drainage, so early-exit diagnostics include all output.
        child.once('close', () =>
          reject(new Error(`Windows handle fixture closed before acquisition: ${diagnostics()}`))
        );
      });
      const exited = new Promise<number | null>((done) => {
        child.once('close', done);
      });
      const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
      let sharingFailures = 0;
      try {
        await acquired;
        vi.mocked(rename).mockImplementation(async (from, to) => {
          try {
            await actual.rename(from, to);
          } catch (error) {
            if (
              String(from).endsWith('.tmp') &&
              ['EPERM', 'EACCES', 'EBUSY'].includes(String(asRecord(error)?.code))
            ) {
              if (sharingFailures++ === 0) child.stdin.end('release\n');
            }
            throw error;
          }
        });
        await cache.dismiss(hash('turn'), digest);
        const exitCode = await exited;
        expect(exitCode, `Windows handle fixture failed: ${diagnostics()}`).toBe(0);
        expect(sharingFailures).toBeGreaterThan(0);
        expect(await new FollowupCache().get(hash('turn'), digest)).toEqual(
          EMPTY_FOLLOWUP_SUGGESTIONS
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    },
    // Cold PowerShell startup on hosted Windows runners can exceed five seconds.
    20_000
  );

  it('admits each turn once across independent owners and reloads', async () => {
    const owners = [new FollowupCache(), new FollowupCache()];
    const claims = await Promise.all(
      owners.map((cache) => cache.claim(hash('turn'), digest, sessionKey))
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await owners[0]!.get(hash('turn'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    await owners[0]!.complete(hash('turn'), digest, suggestions);
    expect(await new FollowupCache().get(hash('turn'), digest)).toEqual(suggestions);
    expect(await new FollowupCache().claim(hash('turn'), digest, sessionKey)).toBe(false);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'followups'))).mode & 0o777).toBe(0o700);
    }
  });

  it('handles Windows lock-rename contention without dropping updates', async () => {
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    let contentions = 0;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      try {
        await actual.rename(from, to);
      } catch (error) {
        if (
          String(to).endsWith('.lock') &&
          ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(asRecord(error)?.code))
        ) {
          contentions++;
          throw Object.assign(new Error('Windows rename contention'), { code: 'EPERM' });
        }
        throw error;
      }
    });
    const owners = Array.from({ length: 4 }, () => new FollowupCache());
    const claims = await Promise.all(
      owners.map((cache) => cache.claim(hash('turn'), digest, sessionKey))
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(contentions).toBeGreaterThan(0);
    await Promise.all(
      owners.map(async (cache, index) => {
        await cache.claim(hash(String(index)), digest, sessionKey);
        await cache.complete(hash(String(index)), digest, suggestions);
      })
    );
    for (let index = 0; index < owners.length; index++)
      expect(await new FollowupCache().get(hash(String(index)), digest)).toEqual(suggestions);
    expect(await readdir(join(directory, 'followups'))).toEqual(['cache.json']);
  });

  it('does not resurrect a dismissed card when another owner completes pending work', async () => {
    const owner = new FollowupCache();
    const other = new FollowupCache();
    await owner.claim(hash('turn'), digest, sessionKey);
    await Promise.all([
      owner.complete(hash('turn'), digest, suggestions),
      other.dismiss(hash('turn'), digest),
    ]);
    await owner.complete(hash('turn'), digest, suggestions);
    expect(await new FollowupCache().get(hash('turn'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await other.claim(hash('turn'), digest, sessionKey)).toBe(false);
  });

  it('retires prior content and pending results after a new prompt, preserving other sessions', async () => {
    const cache = new FollowupCache();
    for (const turn of ['old', 'pending', 'new']) await cache.claim(hash(turn), digest, sessionKey);
    await cache.claim(hash('other'), digest, hash('other-session'));
    for (const turn of ['old', 'new', 'other'])
      await cache.complete(hash(turn), digest, suggestions);
    await new FollowupCache().clearSession(sessionKey, hash('new'));
    await cache.complete(hash('pending'), digest, suggestions);
    const reloaded = new FollowupCache();
    for (const turn of ['old', 'pending']) {
      expect(await reloaded.get(hash(turn), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(await reloaded.claim(hash(turn), digest, sessionKey)).toBe(false);
    }
    for (const turn of ['new', 'other'])
      expect(await reloaded.get(hash(turn), digest)).toEqual(suggestions);
    expect(await reloaded.claim(hash('next'), digest, sessionKey)).toBe(true);
  });

  it('migrates ready, dismissed, failed, and pending admissions before removing workspace data', async () => {
    const snapshot = {
      [hash('ready')]: entry(),
      [hash('dismissed')]: entry(true),
      [hash('stale-dismissal')]: {
        ...entry(),
        dismissed: true,
        suggestions: {
          summary: 'Previously closed suggestion text.',
          actions: [{ title: 'Closed action', prompt: 'Do not retain this closed action.' }],
        },
      },
      [hash('failed')]: { ...entry(), suggestions: EMPTY_FOLLOWUP_SUGGESTIONS },
      [hash('pending')]: { ...entry(), suggestions: EMPTY_FOLLOWUP_SUGGESTIONS },
      [hash('invalid')]: { ...entry(), suggestions: 'corrupt output' },
    };
    const legacy = workspace(snapshot);
    const cache = new FollowupCache(legacy.persistence);
    expect(await cache.get(hash('ready'), digest)).toEqual(suggestions);
    expect(legacy.values.has(storageKey)).toBe(false);
    expect(legacy.persistence.set).not.toHaveBeenCalled();
    for (const turn of ['ready', 'dismissed', 'stale-dismissal', 'failed', 'pending', 'invalid']) {
      expect(await new FollowupCache().claim(hash(turn), digest, sessionKey)).toBe(false);
      if (turn !== 'ready')
        expect(await cache.get(hash(turn), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    }
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('corrupt output');
    expect(persisted).not.toContain('Previously closed suggestion text.');
  });

  it.each([true, false])(
    'never revives dismissal when legacy and disk disagree, disk dismissed=%s',
    async (diskDismissed) => {
      const disk = new FollowupCache();
      await disk.claim(hash('turn'), digest, sessionKey);
      await disk.complete(hash('turn'), digest, suggestions);
      if (diskDismissed) await disk.dismiss(hash('turn'), digest);
      const legacy = workspace({
        [hash('turn')]: entry(!diskDismissed),
        [hash('imported')]: entry(),
      });
      const migrated = new FollowupCache(legacy.persistence);
      expect(await migrated.get(hash('turn'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(await migrated.get(hash('imported'), digest)).toEqual(suggestions);
      expect(await migrated.claim(hash('turn'), digest, sessionKey)).toBe(false);
    }
  );

  it('merges concurrent workspace migrations without losing admissions or dismissals', async () => {
    const first = workspace({ [hash('shared')]: entry(), [hash('first')]: entry() });
    const second = workspace({ [hash('shared')]: entry(true), [hash('second')]: entry() });
    await Promise.all([
      new FollowupCache(first.persistence).get(hash('shared'), digest),
      new FollowupCache(second.persistence).get(hash('shared'), digest),
    ]);
    const reloaded = new FollowupCache();
    expect(await reloaded.get(hash('shared'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    for (const turn of ['shared', 'first', 'second'])
      expect(await reloaded.claim(hash(turn), digest, sessionKey)).toBe(false);
    expect(first.values.has(storageKey)).toBe(false);
    expect(second.values.has(storageKey)).toBe(false);
  });

  it('preserves legacy records and the committed file when atomic publication fails, then retries', async () => {
    const disk = new FollowupCache();
    await disk.claim(hash('existing'), digest, sessionKey);
    const before = await readFile(path, 'utf8');
    const legacy = workspace({ [hash('imported')]: entry(true) });
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith('.tmp')) throw new Error('Publication failed');
      await actual.rename(from, to);
    });
    const migrating = new FollowupCache(legacy.persistence);
    await expect(migrating.get(hash('imported'), digest)).rejects.toThrow('Publication failed');
    expect(legacy.values.has(storageKey)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readdir(join(directory, 'followups'))).toEqual(['cache.json']);
    vi.mocked(rename).mockReset();
    expect(await migrating.get(hash('imported'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await migrating.claim(hash('imported'), digest, sessionKey)).toBe(false);
    expect(legacy.values.has(storageKey)).toBe(false);
  });

  it('keeps readers on the committed snapshot until atomic replacement', async () => {
    const cache = new FollowupCache();
    await cache.claim(hash('turn'), digest, sessionKey);
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    let entered!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>((done) => {
      entered = done;
    });
    const resume = new Promise<void>((done) => {
      release = done;
    });
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith('.tmp')) {
        entered();
        await resume;
      }
      await actual.rename(from, to);
    });
    const pending = cache.complete(hash('turn'), digest, suggestions);
    try {
      await publishing;
      expect(await new FollowupCache().get(hash('turn'), digest)).toEqual(
        EMPTY_FOLLOWUP_SUGGESTIONS
      );
    } finally {
      release();
      await pending;
    }
    expect(await new FollowupCache().get(hash('turn'), digest)).toEqual(suggestions);
  });

  it('keeps committed admission if workspace cleanup fails and safely retries cleanup', async () => {
    const legacy = workspace({ [hash('turn')]: entry(true) });
    vi.spyOn(legacy.persistence, 'remove').mockImplementationOnce(() => {
      throw new Error('Workspace unavailable');
    });
    const cache = new FollowupCache(legacy.persistence);
    await expect(cache.get(hash('turn'), digest)).rejects.toThrow('Workspace unavailable');
    expect(await new FollowupCache().claim(hash('turn'), digest, sessionKey)).toBe(false);
    expect(legacy.values.has(storageKey)).toBe(true);
    expect(await cache.get(hash('turn'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(legacy.values.has(storageKey)).toBe(false);
  });

  it('preserves malformed legacy admission for diagnosis rather than enabling another inference', async () => {
    const legacy = workspace({ [hash('turn')]: { ...entry(), digest: 'invalid' } });
    const cache = new FollowupCache(legacy.persistence);
    await expect(cache.claim(hash('next'), digest, sessionKey)).rejects.toThrow(
      'Invalid follow-up admission'
    );
    expect(legacy.values.has(storageKey)).toBe(true);
    expect(legacy.persistence.remove).not.toHaveBeenCalled();
  });

  it('fails closed instead of discarding unreadable admission data', async () => {
    await mkdir(join(directory, 'followups'));
    await writeFile(path, '{broken');
    const cache = new FollowupCache();
    await expect(cache.get(hash('turn'), digest)).rejects.toThrow('Could not read');
    await expect(cache.claim(hash('turn'), digest, sessionKey)).rejects.toThrow('Could not read');
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  it('bounds suggestion text without losing admissions when multiple workspaces are merged', async () => {
    const snapshot = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [hash(String(index)), entry()])
    );
    const cache = new FollowupCache(workspace(snapshot).persistence);
    expect(await cache.get(hash('0'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await cache.get(hash('512'), digest)).toEqual(suggestions);
    expect(await new FollowupCache().claim(hash('0'), digest, sessionKey)).toBe(false);
  });

  it('keeps identical turns in separate isolated state roots', async () => {
    const first = new FollowupCache();
    await first.claim(hash('turn'), digest, sessionKey);
    await first.dismiss(hash('turn'), digest);
    vi.stubEnv('VARRO_TEST_STATE_ROOT', join(directory, 'second-profile'));
    const second = new FollowupCache();
    expect(await second.claim(hash('turn'), digest, sessionKey)).toBe(true);
    await second.complete(hash('turn'), digest, suggestions);
    expect(await first.get(hash('turn'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await second.get(hash('turn'), digest)).toEqual(suggestions);
    vi.stubEnv('VARRO_TEST_SERVER_URL', 'http://127.0.0.1:49999');
    vi.stubEnv('VARRO_TEST_STATE_ROOT', undefined);
    expect(() => new FollowupCache()).toThrow('isolation is missing');
  });

  it('admits one inference across separate processes without losing concurrent updates', async () => {
    const module = join(directory, 'followup-cache.mjs');
    const compilation = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { build } from 'esbuild';
        await build({ entryPoints: [process.argv[1]], outfile: process.argv[2],
          bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
      `,
        resolve('src/extension/followup-cache.ts'),
        module,
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(compilation.status, compilation.stderr).toBe(0);
    const children = Array.from({ length: 4 }, (_, owner) => {
      const script = `
        import { pathToFileURL } from 'node:url';
        import { createHash } from 'node:crypto';
        const { FollowupCache } = await import(pathToFileURL(process.argv[1]).href);
        const hash = (value) => createHash('sha256').update(value).digest('hex');
        const cache = new FollowupCache();
        const digest = hash('digest'), session = hash('session');
        const admitted = await cache.claim(hash('shared'), digest, session);
        const suggestions = ${JSON.stringify(suggestions)};
        for (let index = 0; index < 8; index++) {
          const turn = hash(process.argv[2] + '-' + index);
          await cache.claim(turn, digest, session);
          await cache.complete(turn, digest, suggestions);
        }
        await cache.dismiss(hash('shared'), digest);
        if (admitted) await cache.complete(hash('shared'), digest, suggestions);
        console.log(JSON.stringify({ admitted }));
      `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, module, String(owner)],
        {
          env: { ...process.env, VARRO_TEST_STATE_ROOT: directory },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let output = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<boolean>((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) done(JSON.parse(output).admitted === true);
          else reject(new Error(`Follow-up fixture exited with ${String(code)}: ${stderr}`));
        });
      });
      return { child, exited };
    });
    try {
      expect(
        (await Promise.all(children.map(({ exited }) => exited))).filter(Boolean)
      ).toHaveLength(1);
      const cache = new FollowupCache();
      expect(await cache.get(hash('shared'), digest)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(await cache.claim(hash('shared'), digest, sessionKey)).toBe(false);
      for (let owner = 0; owner < 4; owner++)
        for (let index = 0; index < 8; index++)
          expect(await cache.get(hash(`${owner}-${index}`), digest)).toEqual(suggestions);
      expect(await readdir(join(directory, 'followups'))).toEqual(['cache.json']);
    } finally {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled(children.map(({ exited }) => exited));
    }
  });
});
