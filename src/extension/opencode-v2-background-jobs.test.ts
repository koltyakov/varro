/* oxlint-disable anti-slop/no-module-mocking -- The adapter logger requires a VS Code extension host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobInfo, SessionActive, ShellInfo } from '@opencode/client';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const shell: ShellInfo = {
  id: 'sh_one',
  status: 'running',
  command: 'npm test',
  cwd: '/repo',
  shell: '/bin/zsh',
  file: '/output',
  metadata: { sessionID: 'ses_root' },
  time: { started: 10 },
};
const shellJob: JobInfo = {
  kind: 'shell',
  id: 'job_shell',
  sessionID: 'ses_root',
  shellID: shell.id,
  command: shell.command,
  status: 'running',
  time: { started: 10 },
};
const subagentJob: JobInfo = {
  kind: 'subagent',
  id: 'job_child',
  sessionID: 'ses_root',
  childSessionID: 'ses_child',
  agent: 'explore',
  description: 'Inspect the project',
  status: 'running',
  time: { started: 20 },
};
const imageJob: JobInfo = {
  kind: 'image',
  id: 'job_image',
  sessionID: 'ses_grandchild',
  path: '/repo/image.png',
  model: 'fixture/image',
  status: 'running',
  time: { started: 30 },
};

type FixtureSession = { id: string; parentID?: string; location: { directory: string } };
type FixtureResponse = { data: unknown };
type FixtureState = {
  jobs: JobInfo[];
  shells: ShellInfo[];
  active: Record<string, SessionActive>;
  jobError?: Error;
  sessions: Map<string, FixtureSession>;
};

function fixture(jobs: JobInfo[] = []) {
  const state: FixtureState = {
    jobs,
    shells: [shell],
    active: {},
    sessions: new Map([
      ['ses_root', { id: 'ses_root', location: { directory: '/repo' } }],
      ['ses_child', { id: 'ses_child', parentID: 'ses_root', location: { directory: '/repo' } }],
      [
        'ses_grandchild',
        { id: 'ses_grandchild', parentID: 'ses_child', location: { directory: '/nested' } },
      ],
      ['ses_other', { id: 'ses_other', location: { directory: '/other' } }],
    ]),
  };
  const wire = vi.fn(async (_method: string, path: string): Promise<FixtureResponse> => {
    const url = new URL(path, 'http://localhost');
    if (path === '/api/session/active') return { data: state.active };
    if (path === '/api/experimental/job') {
      if (state.jobError) throw state.jobError;
      return { data: state.jobs };
    }
    if (url.pathname === '/api/shell') return { data: state.shells };
    if (url.pathname.startsWith('/api/shell/')) return { data: shell };
    const id = decodeURIComponent(url.pathname.slice('/api/session/'.length));
    const session = state.sessions.get(id);
    if (session) return { data: session };
    throw new Error(`404 session not found: ${id}`);
  });
  const adapter = new OpenCodeV2Adapter(wire);
  adapter.setServerVersion('2.2.6');
  const status = () => adapter.request('GET', '/session/status', undefined, { directory: '/repo' });
  return { state, wire, adapter, status };
}

let stateDirectory: string;
beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'varro-native-jobs-'));
  vi.stubEnv('VARRO_TEST_STATE_ROOT', stateDirectory);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(stateDirectory, { recursive: true, force: true });
});

describe('native v2 background jobs', () => {
  it.each([shellJob, subagentJob, { ...imageJob, sessionID: 'ses_root' }])(
    'restores a $kind job without a live shell',
    async (job) => {
      const { state, wire, adapter, status } = fixture([job]);
      state.shells = [];
      expect(await status()).toMatchObject({
        ses_root: { type: 'busy', background: true, backgroundStartedAt: job.time.started },
      });
      expect(adapter.eventContext('ses_root')?.backgroundCommand).toBe(
        job.kind === 'shell' ? job.command : job.kind === 'subagent' ? job.description : job.path
      );
      expect(wire).toHaveBeenCalledWith(
        'GET',
        '/api/experimental/job',
        undefined,
        expect.objectContaining({ unscoped: true })
      );
    }
  );

  it('includes nested jobs across directories without assigning unrelated work to the root', async () => {
    const descendantShell: JobInfo = {
      ...shellJob,
      id: 'job_nested',
      shellID: 'sh_nested',
      sessionID: 'ses_grandchild',
    };
    const { state, wire, adapter, status } = fixture([
      descendantShell,
      subagentJob,
      imageJob,
      { ...imageJob, id: 'job_other', sessionID: 'ses_other' },
    ]);
    state.shells = [];
    expect(await status()).toEqual({
      ses_root: {
        type: 'busy',
        background: true,
        backgroundStartedAt: 10,
        backgroundCommand: 'npm test',
      },
      ses_child: {
        type: 'busy',
        background: true,
        backgroundStartedAt: 10,
        backgroundCommand: 'npm test',
      },
    });
    expect(adapter.eventContext('ses_grandchild')?.backgroundPending).toBe(false);
    expect(adapter.eventContext('ses_other')?.backgroundPending).toBe(false);
    expect(wire.mock.calls.filter(([, path]) => path === '/api/session/ses_root')).toHaveLength(1);
    expect(
      wire.mock.calls.filter(([, path]) => path === '/api/session/ses_grandchild')
    ).toHaveLength(1);
  });

  it('uses the native snapshot rather than treating every session-owned shell as a job', async () => {
    const { status } = fixture();
    expect(await status()).toEqual({});
  });

  it.each([shellJob, subagentJob, imageJob])(
    'keeps ancestors waiting for a descendant $kind job after the parent task settles',
    async (job) => {
      const { state, status } = fixture([{ ...job, sessionID: 'ses_grandchild' }]);
      state.shells = [];
      expect(await status()).toMatchObject({
        ses_root: { background: true, backgroundStartedAt: job.time.started },
        ses_child: { background: true, backgroundStartedAt: job.time.started },
      });
    }
  );

  it.each(['completed', 'error'] as const)(
    'waits for an unconsumed %s job and preserves the completion handoff',
    async (outcome) => {
      vi.useFakeTimers();
      const { state, status } = fixture([{ ...imageJob, sessionID: 'ses_root', status: outcome }]);
      expect(await status()).toMatchObject({ ses_root: { background: true } });
      vi.advanceTimersByTime(60_000);
      expect(await status()).toMatchObject({ ses_root: { background: true } });
      state.jobs = [];
      expect(await status()).toMatchObject({ ses_root: { background: true } });
      vi.advanceTimersByTime(2_000);
      expect(await status()).toEqual({});
    }
  );

  it('does not wait for cancelled jobs or hide active model execution', async () => {
    const { state, status } = fixture([
      { ...imageJob, sessionID: 'ses_root', status: 'cancelled' },
    ]);
    expect(await status()).toEqual({});
    state.jobs = [shellJob, subagentJob];
    state.active = { ses_root: { type: 'running' } };
    expect(await status()).toEqual({ ses_root: { type: 'busy' } });
  });

  it('keeps non-shell work pending when a shell is marked as a service', async () => {
    const { state, adapter, status } = fixture([shellJob, subagentJob]);
    await adapter.request(
      'PATCH',
      '/session/ses_root/background-process/sh_one',
      { service: true },
      { directory: '/repo' }
    );
    expect(await status()).toMatchObject({
      ses_root: {
        background: true,
        backgroundServices: 1,
        backgroundCommand: subagentJob.description,
      },
    });
    state.jobs = [shellJob];
    adapter.observe('session.step.started', { sessionID: 'ses_root' });
    expect(await status()).toEqual({ ses_root: { type: 'idle', backgroundServices: 1 } });
    await adapter.request(
      'PATCH',
      '/session/ses_root/background-process/sh_one',
      { service: false },
      { directory: '/repo' }
    );
    expect(await status()).toMatchObject({
      ses_root: { background: true, backgroundCommand: shell.command },
    });
  });

  it('excludes persisted descendant services from parent waiting', async () => {
    const { state, adapter, status } = fixture([shellJob]);
    await adapter.request(
      'PATCH',
      '/session/ses_root/background-process/sh_one',
      { service: true },
      { directory: '/repo' }
    );
    state.sessions.get('ses_root')!.parentID = 'ses_child';
    state.sessions.get('ses_child')!.parentID = undefined;
    state.sessions.get('ses_root')!.location.directory = '/nested';
    state.shells = [];
    adapter.reset();
    adapter.setServerVersion('2.2.6');
    expect(await status()).toEqual({});
    expect(adapter.eventContext('ses_child')?.backgroundPending).toBe(false);
  });

  it.each(['2.0.5', '2.2.5', undefined])(
    'keeps the shell fallback for server version %s',
    async (version) => {
      const { adapter, wire, status } = fixture([imageJob]);
      adapter.setServerVersion(version);
      expect(await status()).toMatchObject({
        ses_root: { background: true, backgroundCommand: 'npm test' },
      });
      expect(wire.mock.calls.some(([, path]) => path === '/api/experimental/job')).toBe(false);
    }
  );

  it('caches an unavailable route and retries native jobs after reconnect', async () => {
    const { state, adapter, wire, status } = fixture();
    state.jobError = new Error('404 route not found');
    await status();
    expect(await status()).toMatchObject({ ses_root: { background: true } });
    expect(wire.mock.calls.filter(([, path]) => path === '/api/experimental/job')).toHaveLength(1);
    state.jobError = undefined;
    adapter.observe('server.connected', {});
    adapter.observe('session.step.started', { sessionID: 'ses_root' });
    expect(await status()).toEqual({});
    expect(wire.mock.calls.filter(([, path]) => path === '/api/experimental/job')).toHaveLength(2);
  });

  it.each(['401 Unauthorized', '500 unavailable'])(
    'does not replace pending jobs with fallback state after %s',
    async (message) => {
      const { state, adapter, status } = fixture([subagentJob]);
      await status();
      state.jobError = new Error(message);
      await expect(status()).rejects.toThrow(message);
      expect(adapter.eventContext('ses_root')?.backgroundPending).toBe(true);
      state.jobError = undefined;
      expect(await status()).toMatchObject({ ses_root: { background: true } });
    }
  );

  it.each([{}, [{ kind: 'image' }]])('rejects malformed native snapshots: %j', async (response) => {
    const { wire, status } = fixture();
    const original = wire.getMockImplementation()!;
    wire.mockImplementation((method, path) =>
      path === '/api/experimental/job'
        ? Promise.resolve({ data: response })
        : original(method, path)
    );
    await expect(status()).rejects.toThrow('Invalid OpenCode v2 background');
  });

  it('preserves waiting when ancestry cannot be loaded instead of guessing ownership', async () => {
    const { adapter, wire, status } = fixture([imageJob]);
    await status();
    const original = wire.getMockImplementation()!;
    wire.mockImplementation((method, path) => {
      if (path === '/api/session/ses_child') throw new Error('503 ancestry unavailable');
      return original(method, path);
    });
    await expect(status()).rejects.toThrow('503 ancestry unavailable');
    expect(adapter.eventContext('ses_root')?.backgroundPending).toBe(true);
  });

  it('keeps a shell launched after an empty native snapshot began loading', async () => {
    const { state, adapter, wire, status } = fixture();
    state.shells = [];
    const original = wire.getMockImplementation()!;
    let resolve!: (value: { data: JobInfo[] }) => void;
    wire.mockImplementation((method, path) =>
      path === '/api/experimental/job'
        ? new Promise((done) => {
            resolve = done;
          })
        : original(method, path)
    );
    const pending = status();
    adapter.observe('shell.created', { info: shell }, undefined, '/repo');
    adapter.observe('session.execution.succeeded', { sessionID: 'ses_root' });
    resolve({ data: [] });
    expect(await pending).toMatchObject({
      ses_root: { background: true, backgroundCommand: 'npm test' },
    });
  });

  it('does not resurrect a shell that exited while the job snapshot was loading', async () => {
    const { adapter, wire, status } = fixture([shellJob]);
    const original = wire.getMockImplementation()!;
    let resolve!: (value: { data: JobInfo[] }) => void;
    wire.mockImplementation((method, path) =>
      path === '/api/experimental/job'
        ? new Promise((done) => {
            resolve = done;
          })
        : original(method, path)
    );
    adapter.observe('shell.created', { info: shell }, undefined, '/repo');
    const pending = status();
    adapter.observe('shell.exited', { id: shell.id });
    resolve({ data: [shellJob] });
    expect(await pending).toEqual({});
  });

  it('does not restore waiting after interruption during native reconciliation', async () => {
    const { adapter, wire, status } = fixture([subagentJob]);
    const original = wire.getMockImplementation()!;
    let resolve!: (value: { data: JobInfo[] }) => void;
    wire.mockImplementation((method, path) =>
      path === '/api/experimental/job'
        ? new Promise((done) => {
            resolve = done;
          })
        : original(method, path)
    );
    const pending = status();
    adapter.observe('session.execution.interrupted', { sessionID: 'ses_root' });
    resolve({ data: [subagentJob] });
    expect(await pending).toEqual({});
  });

  it('does not replace a newer job snapshot with an older empty response', async () => {
    const { state, wire, status } = fixture();
    const original = wire.getMockImplementation()!;
    let resolve!: (value: { data: JobInfo[] }) => void;
    wire.mockImplementation((method, path) =>
      path === '/api/experimental/job'
        ? new Promise((done) => {
            resolve = done;
          })
        : original(method, path)
    );
    const pending = status();
    wire.mockImplementation(original);
    state.jobs = [subagentJob];
    expect(await status()).toMatchObject({ ses_root: { background: true } });
    resolve({ data: [] });
    expect(await pending).toMatchObject({ ses_root: { background: true } });
  });

  it('discards in-flight job state after reset', async () => {
    const { adapter, wire, status } = fixture();
    const original = wire.getMockImplementation()!;
    let resolve!: (value: { data: JobInfo[] }) => void;
    wire.mockImplementation((method, path) =>
      path === '/api/experimental/job'
        ? new Promise((done) => {
            resolve = done;
          })
        : original(method, path)
    );
    const pending = status();
    adapter.reset();
    resolve({ data: [subagentJob] });
    await expect(pending).rejects.toThrow('background status was reset');
    expect(adapter.eventContext('ses_root')?.backgroundPending).toBe(false);
  });

  it('bounds cyclic ancestry and ignores sessions deleted after the job snapshot', async () => {
    const { state, wire, status } = fixture([
      imageJob,
      { ...subagentJob, sessionID: 'ses_deleted' },
    ]);
    state.sessions.get('ses_root')!.parentID = 'ses_grandchild';
    expect(await status()).toMatchObject({
      ses_root: { background: true },
      ses_child: { background: true },
    });
    expect(wire.mock.calls.filter(([, path]) => path === '/api/session/ses_root')).toHaveLength(1);
  });
});
