/* oxlint-disable anti-slop/no-module-mocking -- The adapter's transport imports the VS Code output channel. */
import { describe, expect, it, vi } from 'vitest';
import type { SessionInboxUser, SessionMessageUser } from '@opencode/client';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { projectV2Message } from './opencode-v2-projection';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const pending: SessionInboxUser = {
  id: 'msg_steer',
  sessionID: 'ses_one',
  type: 'user',
  delivery: 'steer',
  time: { created: 3 },
  payload: {
    text: 'Focus on the adapter',
    files: [
      {
        name: 'example.png',
        mime: 'image/png',
        data: 'aGVsbG8=',
        source: { type: 'uri', uri: 'file:///repo/example.png' },
      },
    ],
    agents: [{ name: 'build' }],
  },
};

const delivered: SessionMessageUser = {
  ...pending.payload,
  id: pending.id,
  type: 'user',
  time: pending.time,
};

const original: SessionMessageUser = {
  id: 'msg_original',
  type: 'user',
  time: { created: 1 },
  text: 'Review the changes',
};

describe('v2 pending steering history', () => {
  it('restores pending prompts on reopen and keeps their identities after delivery', async () => {
    let consumed = false;
    const wire = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/inbox')) return { data: consumed ? [] : [pending] };
      return { data: consumed ? [delivered, original] : [original] };
    });
    const reopen = () =>
      new OpenCodeV2Adapter(wire).request('GET', '/session/ses_one/message', undefined);
    const projectedPending = projectV2Message(delivered, 'ses_one');
    projectedPending.info.pendingDelivery = 'steer';
    const expected = [
      projectV2Message(original, 'ses_one'),
      projectV2Message(delivered, 'ses_one'),
    ];
    expect(await reopen()).toEqual([expected[0], projectedPending]);
    expect(await reopen()).toEqual([expected[0], projectedPending]);
    consumed = true;
    expect(await reopen()).toEqual(expected);
  });

  it('deduplicates a prompt delivered between the inbox and transcript reads', async () => {
    const paths: string[] = [];
    const adapter = new OpenCodeV2Adapter(async (_method, path) => {
      paths.push(path);
      return { data: path.endsWith('/inbox') ? [pending] : [delivered, original] };
    });
    expect(await adapter.request('GET', '/session/ses_one/message', undefined)).toEqual([
      projectV2Message(original, 'ses_one'),
      projectV2Message(delivered, 'ses_one'),
    ]);
    expect(paths).toEqual([
      '/api/session/ses_one/inbox',
      '/api/session/ses_one/message?order=desc&limit=200',
    ]);
  });

  it('appends only user inputs in creation order without changing the history cursor', async () => {
    const adapter = new OpenCodeV2Adapter(async (_method, path) => {
      if (path.endsWith('/inbox'))
        return {
          data: [
            { ...pending, id: 'msg_queue', delivery: 'queue', time: { created: 4 } },
            { ...pending, id: 'msg_internal', type: 'synthetic' },
            pending,
          ],
        };
      return { data: [original], cursor: { next: 'older' } };
    });
    expect(
      await adapter.request('GET', '/session/ses_one/message?limit=1', undefined, {
        captureNextCursor: true,
        stripMessageParts: true,
      })
    ).toMatchObject({
      data: [
        { info: { id: 'msg_original' }, parts: [] },
        { info: { id: 'msg_steer', pendingDelivery: 'steer' }, parts: [] },
        { info: { id: 'msg_queue', pendingDelivery: 'queue' }, parts: [] },
      ],
      nextCursor: 'older',
    });
  });

  it('does not append pending inputs to older history pages', async () => {
    const wire = vi.fn(async () => ({ data: [original] }));
    const adapter = new OpenCodeV2Adapter(wire);
    expect(
      await adapter.request('GET', '/session/ses_one/message?before=older&limit=1', undefined)
    ).toEqual([projectV2Message(original, 'ses_one')]);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(
      'GET',
      '/api/session/ses_one/message?limit=1&cursor=older',
      undefined,
      expect.anything()
    );
  });

  it('shows pending inputs even before the first transcript message exists', async () => {
    const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
      data: path.endsWith('/inbox') ? [pending] : [],
    }));
    const projected = projectV2Message(delivered, 'ses_one');
    projected.info.pendingDelivery = 'steer';
    expect(await adapter.request('GET', '/session/ses_one/message', undefined)).toEqual([
      projected,
    ]);
  });
});
