/* oxlint-disable anti-slop/no-module-mocking -- The adapter's logger requires a VS Code extension host. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellInfo } from '@opencode/client';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { projectV2Event } from './opencode-v2-events';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const shell: ShellInfo = {
  id: 'sh_test',
  status: 'running',
  command: 'npm test',
  cwd: '/repo',
  shell: '/bin/zsh',
  file: '/output',
  metadata: { sessionID: 'ses_one' },
  time: { started: 1 },
};

afterEach(() => vi.useRealTimers());

describe('v2 background completion', () => {
  it('waits after a final answer and through shell exit until the follow-up turn', () => {
    const adapter = new OpenCodeV2Adapter(async () => ({ data: [] }));
    adapter.observe('shell.created', { info: shell }, undefined, '/repo');
    adapter.observe('session.step.ended', { sessionID: 'ses_one', finish: 'stop' });
    const ended = projectV2Event(
      { type: 'session.step.ended', data: { sessionID: 'ses_one', finish: 'stop' } },
      adapter.eventContext('ses_one')
    );
    expect(ended.at(-1)).toMatchObject({
      type: 'session.status',
      properties: { status: { type: 'busy', background: true, backgroundStartedAt: 1 } },
    });
    adapter.observe('session.execution.succeeded', { sessionID: 'ses_one' });
    expect(
      projectV2Event(
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_one' } },
        adapter.eventContext('ses_one')
      )
    ).toMatchObject([{ properties: { status: { type: 'busy', background: true } } }]);
    adapter.observe('shell.exited', { id: shell.id, status: 'exited', exit: 0 });
    expect(adapter.eventContext('ses_one')?.backgroundPending).toBe(true);
    adapter.observe('session.execution.started', { sessionID: 'ses_one' });
    expect(adapter.eventContext('ses_one')?.backgroundPending).toBe(true);
    adapter.observe('session.step.started', { sessionID: 'ses_one' });
    expect(adapter.eventContext('ses_one')?.backgroundPending).toBe(false);
    adapter.observe('session.execution.succeeded', { sessionID: 'ses_one' });
    expect(
      projectV2Event(
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_one' } },
        adapter.eventContext('ses_one')
      )
    ).toMatchObject([{ properties: { status: { type: 'idle' } } }]);
  });

  it('keeps Waiting while another background command is still running', async () => {
    vi.useFakeTimers();
    const other = { ...shell, id: 'sh_second' };
    const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
      data: path === '/api/session/active' ? {} : [other],
    }));
    adapter.observe('shell.created', { info: shell }, undefined, '/repo');
    adapter.observe('shell.created', { info: other }, undefined, '/repo');
    adapter.observe('session.execution.succeeded', { sessionID: 'ses_one' });
    adapter.observe('shell.exited', { id: shell.id, status: 'exited' });
    vi.advanceTimersByTime(60_000);
    expect(
      await adapter.request('GET', '/session/status', undefined, { directory: '/repo' })
    ).toEqual({
      ses_one: { type: 'busy', background: true, backgroundStartedAt: 1 },
    });
  });

  it('restores Waiting from running shells when opening an idle session', async () => {
    const wire = vi.fn(async (_method: string, path: string) => ({
      data: path === '/api/session/active' ? { ses_other: { type: 'running' } } : [shell],
    }));
    const adapter = new OpenCodeV2Adapter(wire);
    expect(
      await adapter.request('GET', '/session/status', undefined, { directory: '/repo' })
    ).toEqual({
      ses_one: { type: 'busy', background: true, backgroundStartedAt: 1 },
      ses_other: { type: 'busy' },
    });
    expect(wire).toHaveBeenCalledWith(
      'GET',
      '/api/shell?location%5Bdirectory%5D=%2Frepo',
      undefined,
      expect.anything()
    );
  });

  it('does not let an old shell snapshot resurrect an exited command', async () => {
    let resolveShells!: (value: { data: ShellInfo[] }) => void;
    const adapter = new OpenCodeV2Adapter(async (_method, path) => {
      if (path === '/api/session/active') return { data: {} };
      return new Promise<{ data: ShellInfo[] }>((resolve) => {
        resolveShells = resolve;
      });
    });
    adapter.observe('shell.created', { info: shell }, undefined, '/repo');
    const pending = adapter.request('GET', '/session/status', undefined, { directory: '/repo' });
    adapter.observe('shell.exited', { id: shell.id, status: 'exited' });
    resolveShells({ data: [shell] });
    expect(await pending).toEqual({});
  });

  it('recovers missed follow-up events after the bounded handoff window', async () => {
    vi.useFakeTimers();
    const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
      data: path === '/api/session/active' ? {} : [],
    }));
    adapter.observe('shell.created', { info: shell }, undefined, '/repo');
    adapter.observe('session.execution.succeeded', { sessionID: 'ses_one' });
    adapter.observe('shell.exited', { id: shell.id, status: 'exited' });
    expect(
      await adapter.request('GET', '/session/status', undefined, { directory: '/repo' })
    ).toEqual({ ses_one: { type: 'busy', background: true } });
    vi.advanceTimersByTime(2_000);
    expect(
      await adapter.request('GET', '/session/status', undefined, { directory: '/repo' })
    ).toEqual({});
  });

  it.each(['failed', 'interrupted'])(
    'does not turn a %s execution back into Waiting',
    async (outcome) => {
      const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
        data: path === '/api/session/active' ? {} : [shell],
      }));
      adapter.observe('shell.created', { info: shell }, undefined, '/repo');
      adapter.observe(`session.execution.${outcome}`, { sessionID: 'ses_one' });
      expect(
        await adapter.request('GET', '/session/status', undefined, { directory: '/repo' })
      ).toEqual({});
    }
  );

  it('stops only the waiting session shells when Stop is requested', async () => {
    const wire = vi.fn(async (_method: string, _path: string) => ({}));
    const adapter = new OpenCodeV2Adapter(wire);
    adapter.observe('shell.created', { info: shell }, undefined, '/repo');
    adapter.observe(
      'shell.created',
      { info: { ...shell, id: 'sh_other', metadata: { sessionID: 'ses_other' } } },
      undefined,
      '/repo'
    );
    adapter.observe('session.execution.succeeded', { sessionID: 'ses_one' });
    await adapter.request('POST', '/session/ses_one/abort', {}, { directory: '/repo' });
    expect(wire.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ['DELETE', '/api/shell/sh_test?location%5Bdirectory%5D=%2Frepo'],
      ['POST', '/api/session/ses_one/interrupt'],
    ]);
    expect(adapter.eventContext('ses_one')?.backgroundPending).toBe(false);
  });
});
