/* oxlint-disable anti-slop/no-module-mocking -- The HTTP adapter imports the extension logger; transcript fixtures run without a VS Code host. */
import { describe, expect, it, vi } from 'vitest';
import type { SessionMessageInfo } from '@opencode/client';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { projectV2Event } from './opencode-v2-events';
import { projectV2Message } from './opencode-v2-projection';
import { parseServerEvent } from '../shared/protocol';
import { parseSkillAttachment } from '../shared/skill-reference';
import { asRecord } from '../shared/type-utils';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('V2 transcript deletion', () => {
  const user: SessionMessageInfo = {
    id: 'msg_user',
    type: 'user',
    text: 'Run tests',
    time: { created: 1 },
  };
  const assistant: SessionMessageInfo = {
    id: 'msg_assistant',
    type: 'assistant',
    agent: 'build',
    model: { providerID: 'openai', id: 'gpt-6-astra' },
    content: [],
    time: { created: 2, completed: 3 },
    finish: 'error',
    error: { type: 'provider.auth', message: 'You are signed out of this provider.', status: 401 },
  };
  const failed: SessionMessageInfo = {
    id: 'msg_failed',
    type: 'idle',
    outcome: 'failed',
    time: { created: 4 },
  };

  it.each([0, 19, 25])(
    'deletes a failed turn in visible reverse order with %i trailing control records',
    async (controlCount) => {
      let records: SessionMessageInfo[] = [
        user,
        assistant,
        failed,
        ...Array.from({ length: controlCount }, (_, index): SessionMessageInfo => ({
          id: `msg_control_${index}`,
          type: 'system',
          text: 'Tool catalog updated',
          time: { created: 5 + index },
        })),
      ];
      let staged: string | undefined;
      const wire = vi.fn<ConstructorParameters<typeof OpenCodeV2Adapter>[0]>(
        async (method, path, body) => {
          const url = new URL(path, 'http://localhost');
          if (method === 'GET' && url.pathname.endsWith('/inbox')) return { data: [] };
          if (method === 'GET' && url.pathname.endsWith('/message')) {
            const cursor = url.searchParams.get('cursor');
            const end = cursor
              ? records.findIndex((record) => record.id === cursor)
              : records.length;
            const start = Math.max(0, end - Number(url.searchParams.get('limit')));
            return {
              data: records.slice(start, end).toReversed(),
              cursor: { next: start > 0 ? records[start]?.id : undefined },
            };
          }
          if (method === 'POST' && path.endsWith('/revert/stage')) {
            expect(body).toEqual({ messageID: expect.any(String), files: false });
            staged = String(asRecord(body)?.messageID);
            return {};
          }
          if (method === 'POST' && path.endsWith('/revert/commit')) {
            const index = records.findIndex((record) => record.id === staged);
            expect(index).toBeGreaterThanOrEqual(0);
            records = records.slice(0, index);
            return {};
          }
          throw new Error(`Unexpected request: ${method} ${path}`);
        }
      );
      const adapter = new OpenCodeV2Adapter(wire);
      expect(await adapter.request('GET', '/session/ses_one/message', undefined)).toMatchObject([
        { info: { id: user.id } },
        { info: { id: assistant.id } },
      ]);
      for (const message of [assistant, user]) {
        await expect(
          adapter.request('DELETE', `/session/ses_one/message/${message.id}`, undefined)
        ).resolves.toBe(true);
      }
      expect(records).toEqual([]);
    }
  );

  it('deletes a standalone failure record before its user message', async () => {
    const wire = vi.fn(async () => ({ data: [failed, user], cursor: {} }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('DELETE', `/session/ses_one/message/${failed.id}`, undefined)
    ).resolves.toBe(true);
    expect(wire).toHaveBeenCalledWith(
      'POST',
      '/api/session/ses_one/revert/stage',
      { messageID: failed.id, files: false },
      expect.anything()
    );
  });

  it.each([
    { name: 'newer user', records: [user, assistant], target: assistant.id },
    { name: 'newer assistant', records: [assistant, user], target: user.id },
    { name: 'standalone failure', records: [failed, user], target: user.id },
    {
      name: 'failure after a successful assistant',
      records: [failed, { ...assistant, error: undefined, finish: 'stop' }],
      target: assistant.id,
    },
    { name: 'missing target', records: [], target: 'msg_missing' },
  ])('refuses deletion across $name', async ({ records, target }) => {
    const wire = vi.fn(async () => ({ data: records, cursor: {} }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('DELETE', `/session/ses_one/message/${target}`, undefined)
    ).rejects.toThrow('can only delete messages from the end of the transcript');
    expect(wire.mock.calls).toHaveLength(1);
  });

  it('stops without deleting when control-only pages repeat a cursor', async () => {
    const wire = vi.fn(async () => ({ data: [], cursor: { next: 'repeated' } }));
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('DELETE', `/session/ses_one/message/${user.id}`, undefined)
    ).rejects.toThrow('OpenCode repeated a message pagination cursor');
    expect(wire).toHaveBeenCalledTimes(2);
  });
});

describe('V2 generated transcript records', () => {
  const base = { id: 'msg_generated', time: { created: 10 } };

  it('preserves automatic retry metadata on history and direct message reads', async () => {
    const record: SessionMessageInfo = {
      ...base,
      type: 'assistant',
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-6-astra' },
      content: [],
      time: { created: 10, completed: 20 },
      finish: 'error',
      error: { type: 'provider.transport', message: 'WebSocket closed with code 1006' },
      retry: {
        attempt: 2,
        at: 22,
        error: { type: 'provider.transport', message: 'WebSocket closed with code 1006' },
      },
    };
    const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
      data: path.endsWith('/inbox') ? [] : path.includes('/message/') ? record : [record],
      cursor: {},
    }));
    const expected = {
      info: {
        retry: { attempt: 2, at: 22 },
        error: {
          name: 'provider.transport',
          data: { message: 'WebSocket closed with code 1006' },
        },
      },
    };
    expect(await adapter.request('GET', '/session/ses_one/message', undefined)).toMatchObject([
      expected,
    ]);
    expect(
      await adapter.request('GET', '/session/ses_one/message/msg_generated', undefined)
    ).toMatchObject(expected);
  });

  it.each(['running', 'completed', 'failed'] as const)(
    'keeps %s compaction out of user text and preserves its status',
    async (status) => {
      const record: SessionMessageInfo =
        status === 'failed'
          ? {
              ...base,
              type: 'compaction',
              status,
              reason: 'auto',
              error: { type: 'unknown', message: 'Summary failed' },
            }
          : {
              ...base,
              type: 'compaction',
              status,
              reason: 'auto',
              summary: '## Objective\n\nGenerated instructions',
              recent: '',
            };
      const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
        data: path.endsWith('/inbox') ? [] : [record],
        cursor: {},
      }));
      const projected = projectV2Message(record, 'ses_one');
      expect(projected.parts).toEqual([
        expect.objectContaining({ type: 'compaction', auto: true, status }),
      ]);
      if (status === 'failed') expect(projected.parts[0]?.error).toBe('Summary failed');
      expect(await adapter.request('GET', '/session/ses_one/message', undefined)).toEqual([
        projected,
      ]);
      expect(
        await new OpenCodeV2Adapter(async () => ({ data: record })).request(
          'GET',
          '/session/ses_one/message/msg_generated',
          undefined
        )
      ).toEqual(projected);
    }
  );

  it('renders skill activation as assistant activity instead of a user instruction bubble', () => {
    const projected = projectV2Message(
      {
        ...base,
        type: 'skill',
        skill: 'review',
        name: 'Review',
        text: 'Internal skill instructions',
      },
      'ses_one'
    );
    expect(projected.info).toMatchObject({
      role: 'assistant',
      time: { created: 10, completed: 10 },
    });
    expect(projected.parts).toEqual([
      expect.objectContaining({
        type: 'tool',
        tool: 'skill',
        state: expect.objectContaining({
          status: 'completed',
          input: { name: 'review' },
          output: 'Internal skill instructions',
        }),
      }),
    ]);
  });

  it('preserves user-selected skill attachments without exposing their expanded instructions', () => {
    const projected = projectV2Message(
      {
        ...base,
        type: 'user',
        text: 'Review this',
        agents: [{ name: 'build' }],
        skills: [{ id: 'review', name: 'Code review', text: 'Internal skill instructions' }],
      },
      'ses_one'
    );
    expect(projected.info.role).toBe('user');
    expect(projected.parts[0]).toMatchObject({ type: 'text', text: 'Review this' });
    expect(projected.parts[1]).toMatchObject({ type: 'agent', name: 'build' });
    expect(parseSkillAttachment(String(projected.parts[2]?.text))).toBe('Code review');
    expect(JSON.stringify(projected.parts)).not.toContain('Internal skill instructions');
    expect(new Set(projected.parts.map((part) => part.id)).size).toBe(3);
  });

  it('retains unsuccessful shell exit status and output', () => {
    expect(
      projectV2Message(
        {
          ...base,
          type: 'shell',
          shellID: 'shell_failed',
          command: 'false',
          status: 'exited',
          exit: 1,
          output: { output: 'Command failed', cursor: 14, size: 14, truncated: false },
        },
        'ses_one'
      ).parts[0]
    ).toMatchObject({
      type: 'tool',
      state: { status: 'error', error: 'Command failed\nShell exited with code 1' },
    });
  });

  it.each(['running', 'exited', 'timeout', 'killed'] as const)(
    'renders %s shell output as a command activity',
    (status) => {
      const projected = projectV2Message(
        {
          ...base,
          type: 'shell',
          shellID: 'shell_one',
          command: 'pwd',
          status,
          time: { created: 10, completed: status === 'running' ? undefined : 20 },
          output: { output: '/workspace', cursor: 10, size: 10, truncated: false },
        },
        'ses_one'
      );
      expect(projected.info.role).toBe('assistant');
      expect(projected.parts).toEqual([
        expect.objectContaining({
          type: 'tool',
          tool: 'bash',
          callID: 'shell_one',
          state: expect.objectContaining({
            status: status === 'running' ? 'running' : status === 'exited' ? 'completed' : 'error',
            input: { command: 'pwd' },
          }),
        }),
      ]);
      if (status === 'exited')
        expect(projected.parts[0]).toMatchObject({ state: { output: '/workspace' } });
      if (status === 'timeout' || status === 'killed') {
        expect(projected.parts[0]).toMatchObject({
          state: { error: expect.stringContaining(status) },
        });
      }
    }
  );

  it.each(['system'] as const)('does not expose %s text on direct message reads', async (type) => {
    const adapter = new OpenCodeV2Adapter(async () => ({
      data: { ...base, type, text: 'Internal instructions' },
    }));
    expect(
      await adapter.request('GET', '/session/ses_one/message/msg_generated', undefined)
    ).toMatchObject({ parts: [] });
  });

  it('preserves synthetic provenance on history and direct reads for action notices', async () => {
    const record: SessionMessageInfo = {
      ...base,
      type: 'synthetic',
      text: 'The server restarted while you were working.',
    };
    const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
      data: path.endsWith('/inbox') ? [] : path.includes('/message/') ? record : [record],
      cursor: {},
    }));
    const expected = {
      info: { id: base.id, role: 'user' },
      parts: [{ type: 'text', text: record.text, synthetic: true }],
    };
    expect(await adapter.request('GET', '/session/ses_one/message', undefined)).toMatchObject([
      expected,
    ]);
    expect(
      await adapter.request('GET', '/session/ses_one/message/msg_generated', undefined)
    ).toMatchObject(expected);
  });

  it.each(['skill', 'shell'] as const)(
    'keeps a paginated %s activity attached to the original prompt',
    async (type) => {
      const record: SessionMessageInfo =
        type === 'skill'
          ? { ...base, type, skill: 'review', name: 'Review', text: 'Instructions' }
          : { ...base, type, shellID: 'shell_one', command: 'pwd', status: 'exited' };
      const wire = vi.fn(async (_method: string, path: string) => {
        if (path.endsWith('/inbox')) return { data: [] };
        if (path.endsWith('/msg_generated')) return { data: record };
        if (path.includes('cursor=older'))
          return {
            data: [{ id: 'msg_user', type: 'user', text: 'Review', time: { created: 1 } }],
            cursor: {},
          };
        return { data: [record], cursor: { next: 'older' } };
      });
      const adapter = new OpenCodeV2Adapter(wire);
      adapter.observe('session.model.selected', {
        sessionID: 'ses_one',
        model: { id: 'model', providerID: 'provider' },
      });
      expect(
        await adapter.request('GET', '/session/ses_one/message?limit=1', undefined, {
          captureNextCursor: true,
        })
      ).toMatchObject({
        data: [{ info: { role: 'assistant', parentID: 'msg_user', modelID: 'model' } }],
        nextCursor: 'older',
      });
      expect(
        await adapter.request('GET', '/session/ses_one/message/msg_generated', undefined)
      ).toMatchObject({
        info: { role: 'assistant', parentID: 'msg_user', modelID: 'model' },
      });
    }
  );

  it.each(['started', 'ended'] as const)('refreshes native shell %s records', (phase) => {
    const events = projectV2Event({
      id: 'evt_shell',
      created: 10,
      type: `session.shell.${phase}`,
      durable: { seq: 5 },
      data: { sessionID: 'ses_one', shell: { id: 'shell_one', command: 'pwd' } },
    }).map(parseServerEvent);
    expect(events).toEqual([
      expect.objectContaining({
        type: `session.next.shell.${phase}`,
        seq: 5,
        properties: expect.objectContaining({ sessionID: 'ses_one' }),
      }),
    ]);
  });

  it('refreshes skill activation records', () => {
    expect(
      projectV2Event({
        id: 'evt_skill',
        created: 10,
        type: 'session.skill.activated',
        durable: { seq: 6 },
        data: { sessionID: 'ses_one', id: 'review', name: 'Review', text: 'Instructions' },
      }).map(parseServerEvent)
    ).toEqual([expect.objectContaining({ type: 'session.next.synthetic', seq: 6 })]);
  });

  it('refreshes failed compaction before reporting the failure, consuming its sequence once', () => {
    const events = projectV2Event({
      id: 'evt_failed',
      created: 10,
      type: 'session.compaction.failed',
      durable: { seq: 7 },
      data: {
        sessionID: 'ses_one',
        reason: 'auto',
        error: { type: 'unknown', message: 'Summary failed' },
      },
    }).map(parseServerEvent);
    expect(events).toMatchObject([
      { type: 'session.next.compaction.ended', seq: 7 },
      { type: 'session.error', properties: { error: { data: { message: 'Summary failed' } } } },
    ]);
    expect(events.filter((event) => event?.seq !== undefined)).toHaveLength(1);
  });
});
