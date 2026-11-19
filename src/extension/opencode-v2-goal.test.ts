import { describe, expect, it, vi } from 'vitest';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { projectV2Event } from './opencode-v2-events';
import { projectV2Message } from './opencode-v2-projection';
import { parseServerEvent } from '../shared/protocol';

/* oxlint-disable anti-slop/no-module-mocking -- The adapter's logger requires a VS Code host. */
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const goal = {
  id: 'goal-1',
  objective: 'Wait for 1 minute',
  status: 'active',
  rounds: 0,
  maxRounds: 50,
  updatedAt: 1,
};
const kickoff = {
  id: 'msg_goal',
  type: 'synthetic' as const,
  description: 'Goal: Wait for 1 minute',
  text: 'A goal is now active.\n<untrusted_objective>\nWait for 1 minute\n</untrusted_objective>\nStart now.',
  metadata: { source: 'goal', goalID: goal.id },
  time: { created: 1 },
};

describe('native session goals', () => {
  it('reads goal state through the location-scoped plugin RPC without mutating the session', async () => {
    const wire = vi.fn(async () => ({ output: goal }));
    const adapter = new OpenCodeV2Adapter(wire);
    expect(
      await adapter.request('GET', '/session/ses_one/goal?directory=%2Frepo', undefined)
    ).toEqual(goal);
    expect(wire).toHaveBeenCalledExactlyOnceWith(
      'POST',
      '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Frepo',
      { input: { sessionID: 'ses_one' } },
      expect.objectContaining({ unscoped: true })
    );
  });

  it('distinguishes no goal from a malformed goal response', async () => {
    const wire = vi
      .fn()
      .mockResolvedValueOnce({ output: null })
      .mockResolvedValueOnce({ data: goal });
    const adapter = new OpenCodeV2Adapter(wire);
    expect(await adapter.request('GET', '/session/ses_one/goal', undefined)).toBeNull();
    await expect(adapter.request('GET', '/session/ses_one/goal', undefined)).rejects.toThrow(
      'Invalid OpenCode goal response'
    );
  });

  it.each([goal, { ...goal, status: 'paused' }, { ...goal, status: 'complete' }, null])(
    'projects plugin changes including clearing a goal',
    (next) => {
      const events = projectV2Event({
        id: 'evt_goal',
        type: 'rpc.opencode.goal.changed',
        location: { directory: '/repo' },
        data: { sessionID: 'ses_one', goal: next },
      });
      expect(events).toHaveLength(1);
      expect(parseServerEvent(events[0])).toMatchObject({
        type: 'session.goal.updated',
        workspaceDirectory: '/repo',
        properties: { sessionID: 'ses_one', goal: next },
      });
    }
  );

  it('rejects malformed goal events instead of clearing a visible goal', () => {
    expect(
      projectV2Event({
        type: 'rpc.opencode.goal.changed',
        data: { sessionID: 'ses_one', goal: { ...goal, status: 'unknown' } },
      })
    ).toEqual([]);
  });

  it('shows the kickoff as the user prompt, retaining its native message and part IDs', () => {
    const projected = projectV2Message(kickoff, 'ses_one');
    expect(projected).toMatchObject({
      info: { id: 'msg_goal', role: 'user' },
      parts: [{ id: 'msg_goal:content:0', text: '/goal Wait for 1 minute' }],
    });
    expect(projected.parts[0]).not.toHaveProperty('synthetic');
    expect(projectV2Message({ ...kickoff, description: undefined }, 'ses_one').parts).toEqual([]);
  });

  it('parents streamed replies to the delivered kickoff, not internal continuations', () => {
    const adapter = new OpenCodeV2Adapter(vi.fn());
    adapter.observe('session.inbox.enqueued', {
      sessionID: 'ses_one',
      inboxID: kickoff.id,
      item: { type: 'synthetic', payload: kickoff },
    });
    adapter.observe('session.inbox.delivered', { sessionID: 'ses_one', inboxID: kickoff.id });
    expect(adapter.eventContext('ses_one')?.parentID).toBe(kickoff.id);
    adapter.observe('session.inbox.enqueued', {
      sessionID: 'ses_one',
      inboxID: 'msg_continue',
      item: { type: 'synthetic', payload: { ...kickoff, description: undefined } },
    });
    adapter.observe('session.inbox.delivered', { sessionID: 'ses_one', inboxID: 'msg_continue' });
    expect(adapter.eventContext('ses_one')?.parentID).toBe(kickoff.id);
  });

  it('preserves the full multiline objective and decodes escaped text exactly once', () => {
    const objective = 'Check <tag> & keep &lt; literal\nThen verify';
    const escaped = objective
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    const projected = projectV2Message(
      {
        ...kickoff,
        description: 'Goal: truncated...',
        text: `<untrusted_objective>\n${escaped}\n</untrusted_objective>`,
      },
      'ses_one'
    );
    expect(projected.parts[0]?.text).toBe(`/goal ${objective}`);
  });

  it('keeps attachments on goal kickoffs sent as native user messages', () => {
    const projected = projectV2Message(
      {
        ...kickoff,
        type: 'user',
        files: [
          {
            mime: 'text/plain',
            name: 'notes.txt',
            source: { type: 'uri', uri: 'file:///repo/notes.txt' },
            data: '',
          },
        ],
      },
      'ses_one'
    );
    expect(projected.parts).toMatchObject([
      { text: '/goal Wait for 1 minute' },
      { type: 'file', filename: 'notes.txt' },
    ]);
  });

  it('shows an inbox kickoff once under the same identity after delivery and parents the reply to it', async () => {
    let delivered = false;
    const wire = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/inbox'))
        return {
          data: delivered
            ? []
            : [{ id: kickoff.id, type: 'synthetic', payload: kickoff, time: kickoff.time }],
        };
      return {
        data: delivered
          ? [
              {
                id: 'msg_assistant',
                type: 'assistant',
                model: { providerID: 'openai', id: 'test-model' },
                agent: 'build',
                content: [{ type: 'text', text: 'Done' }],
                time: { created: 2 },
              },
              kickoff,
            ]
          : [],
      };
    });
    const adapter = new OpenCodeV2Adapter(wire);
    const read = () => adapter.request('GET', '/session/ses_one/message?limit=10', undefined);
    expect(await read()).toMatchObject([
      { info: { id: kickoff.id }, parts: [{ text: '/goal Wait for 1 minute' }] },
    ]);
    delivered = true;
    expect(await read()).toMatchObject([
      { info: { id: kickoff.id }, parts: [{ text: '/goal Wait for 1 minute' }] },
      { info: { id: 'msg_assistant', parentID: kickoff.id } },
    ]);
  });
});
