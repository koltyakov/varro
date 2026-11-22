import { describe, expect, it, vi } from 'vitest';
import type {
  SessionInboxInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessagesResponse,
  TokenUsageInfo,
} from '@opencode/client';
import { readSessionFollowupUsage, summarizeFollowupUsage } from './followup-usage';
import { OpenCodeResponseTooLargeError } from './opencode-response-error';

function user(id: string, created = 0): SessionMessageInfo {
  return { id, type: 'user', text: id, time: { created } };
}

function inboxItem(id: string, type: 'user' | 'synthetic'): SessionInboxInfo {
  // SAFETY: The reader inspects only inbox item IDs and types; payloads are irrelevant here.
  return { id, type } as SessionInboxInfo;
}

function tokens(input: number, output = 0, extra: Partial<TokenUsageInfo> = {}): TokenUsageInfo {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 }, ...extra };
}

function step(
  id: string,
  usage: TokenUsageInfo | undefined,
  options: { cost?: number; completed?: boolean; error?: boolean; retry?: boolean } = {}
): SessionMessageInfo {
  const record: SessionMessageAssistant = {
    id,
    type: 'assistant',
    agent: 'build',
    model: { providerID: 'provider', id: 'model' },
    content: [],
    time: { created: 0 },
  };
  if (options.completed !== false) record.time.completed = 1;
  if (usage) record.tokens = usage;
  if (options.cost !== undefined) record.cost = options.cost;
  if (options.error) record.error = { type: 'provider', message: 'failed' };
  if (options.retry)
    record.retry = { attempt: 1, at: 0, error: { type: 'provider', message: 'rate' } };
  return record;
}

const complete = { complete: true, pendingPromptIDs: [] };

describe('summarizeFollowupUsage', () => {
  it('attributes each step to the latest delivered prompt group in persisted order', () => {
    // IDs and timestamps run backwards on purpose: persisted order alone defines delivery.
    const summary = summarizeFollowupUsage(
      [
        user('msg_z_a', 50),
        step('msg_y_step1', tokens(10, 1)),
        user('msg_x_b', 40),
        user('msg_w_c', 30),
        step('msg_v_step2', tokens(20, 2)),
        user('msg_u_direct_d', 20),
        step('msg_t_step3', tokens(40, 4)),
      ],
      complete
    );

    expect(summary.intervals.map(({ promptIDs, usage, final }) => [promptIDs, usage.input, final]))
      .toMatchInlineSnapshot(`
      [
        [
          [
            "msg_z_a",
          ],
          10,
          true,
        ],
        [
          [
            "msg_x_b",
            "msg_w_c",
          ],
          20,
          true,
        ],
        [
          [
            "msg_u_direct_d",
          ],
          40,
          false,
        ],
      ]
    `);
    expect(summary.intervals.some((interval) => interval.boundaryUnknown)).toBe(false);
  });

  it('keeps settled intervals unchanged when later work arrives', () => {
    const before = summarizeFollowupUsage(
      [user('a'), step('s1', tokens(5, 1)), user('b'), step('s2', tokens(7, 1))],
      complete
    );
    const after = summarizeFollowupUsage(
      [
        user('a'),
        step('s1', tokens(5, 1)),
        user('b'),
        step('s2', tokens(7, 1)),
        {
          id: 'syn',
          type: 'synthetic',
          text: 'notice',
          time: { created: 0 },
        },
        step('s3', tokens(11, 1)),
      ],
      complete
    );

    expect(after.intervals[0]).toEqual(before.intervals[0]);
    // Synthetic inputs continue the open interval rather than starting a new one.
    expect(after.intervals[1]?.usage.input).toBe(18);
    expect(after.intervals[1]?.final).toBe(false);
  });

  it('separates recorded zeros, missing usage, active steps, and retries', () => {
    const summary = summarizeFollowupUsage(
      [
        user('a'),
        step('zero', tokens(0)),
        step('failed-no-usage', undefined, { error: true }),
        step('retried', tokens(3, 2, { reasoning: 4, cache: { read: 100, write: 6 } }), {
          retry: true,
          cost: 0.25,
        }),
        step('retried', tokens(3, 2), { retry: true }),
        step('streaming', undefined, { completed: false }),
      ],
      complete
    );

    expect(summary.intervals[0]?.usage).toEqual({
      input: 3,
      output: 2,
      reasoning: 4,
      cacheRead: 100,
      cacheWrite: 6,
      cost: 0.25,
      steps: 2,
      missing: 1,
      active: 1,
    });
  });

  it('leaves adopted compaction out of follow-up intervals', () => {
    // Background summarization started under A can be adopted after B is delivered.
    const summary = summarizeFollowupUsage(
      [
        user('a'),
        step('s1', tokens(1)),
        user('b'),
        {
          id: 'compact',
          type: 'compaction',
          status: 'completed',
          reason: 'auto',
          summary: '',
          tokens: tokens(900, 90),
          cost: 5,
          time: { created: 0 },
        },
        step('s2', tokens(2)),
      ],
      complete
    );

    expect(
      summary.intervals.map((interval) => [interval.usage.input, interval.usage.cost])
    ).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it('treats a described goal kickoff as a prompt boundary but not an automatic continuation', () => {
    const summary = summarizeFollowupUsage(
      [
        user('a'),
        step('s1', tokens(1)),
        {
          id: 'goal',
          type: 'synthetic',
          text: 'kickoff',
          description: 'Ship it',
          metadata: { source: 'goal' },
          time: { created: 0 },
        },
        step('s2', tokens(2)),
        {
          id: 'continue',
          type: 'synthetic',
          text: 'continue',
          metadata: { source: 'goal' },
          time: { created: 0 },
        },
        step('s3', tokens(4)),
      ],
      complete
    );

    expect(
      summary.intervals.map(({ promptIDs, usage, final }) => [promptIDs, usage.input, final])
    ).toEqual([
      [['a'], 1, true],
      [['goal'], 6, false],
    ]);
  });

  it('settles rows left unfinished when an execution goes idle', () => {
    // A retry was scheduled before output, then the user interrupted the child.
    const summary = summarizeFollowupUsage(
      [
        user('a'),
        step('s1', tokens(3, 1)),
        step('retrying', undefined, { completed: false, retry: true }),
        { id: 'idle', type: 'idle', outcome: 'interrupted', time: { created: 0 } },
      ],
      complete
    );

    expect(summary.intervals[0]?.usage).toMatchObject({ steps: 1, missing: 1, active: 0 });
    expect(summary.intervals[0]?.final).toBe(false);
  });

  it('marks only the oldest read group as uncertain when history is incomplete', () => {
    const split = summarizeFollowupUsage(
      [user('c'), step('s2', tokens(2)), user('d'), step('s3', tokens(3))],
      { complete: false, pendingPromptIDs: [] }
    );
    expect(split.intervals.map((interval) => interval.boundaryUnknown ?? false)).toEqual([
      true,
      false,
    ]);

    // A model step before the oldest read prompt proves where its group starts.
    const bounded = summarizeFollowupUsage(
      [step('s1', tokens(1)), user('c'), step('s2', tokens(2))],
      {
        complete: false,
        pendingPromptIDs: [],
      }
    );
    expect(bounded.intervals).toHaveLength(1);
    expect(bounded.intervals[0]?.boundaryUnknown).toBeUndefined();
    expect(bounded.intervals[0]?.usage.input).toBe(2);
  });
});

describe('readSessionFollowupUsage', () => {
  function reader(pages: SessionMessageInfo[][], inbox: SessionInboxInfo[] = []) {
    const readPage = vi.fn(async (cursor: string | undefined): Promise<SessionMessagesResponse> => {
      const index = cursor ? Number(cursor) : 0;
      // OpenCode returns a next cursor with every non-empty page, including the last one.
      return { data: pages[index] ?? [], cursor: { next: String(index + 1) } };
    });
    return { readInbox: vi.fn(async () => inbox), readPage };
  }

  it('follows cursors until an empty page and reads newest first', async () => {
    // Each page is newest first; older pages follow by cursor.
    const source = reader([
      [step('s2', tokens(2)), user('c'), user('b')],
      [step('s1', tokens(1)), user('a')],
    ]);

    const summary = await readSessionFollowupUsage(source);

    expect(summary.complete).toBe(true);
    expect(summary.intervals.map((interval) => interval.promptIDs)).toEqual([['a'], ['b', 'c']]);
    expect(source.readPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, '1', '2']);
    expect(source.readInbox.mock.invocationCallOrder[0]).toBeLessThan(
      source.readPage.mock.invocationCallOrder[0]!
    );
  });

  it('reports a page-limited read as incomplete and never shares across the unread edge', async () => {
    // B and C were delivered together, but B sits on the page beyond the limit.
    const source = reader([
      [step('s3', tokens(3)), user('d'), step('s2', tokens(2)), user('c')],
      [user('b'), step('s1', tokens(1)), user('a')],
    ]);

    const summary = await readSessionFollowupUsage(source, { maxPages: 1 });

    expect(summary.complete).toBe(false);
    expect(summary.intervals).toEqual([
      expect.objectContaining({ promptIDs: ['c'], boundaryUnknown: true }),
      expect.objectContaining({ promptIDs: ['d'], final: false }),
    ]);
    expect(summary.intervals[1]).not.toHaveProperty('boundaryUnknown');
  });

  it('stops at the byte budget without counting the oversized page', async () => {
    const source = reader([
      [step('s2', tokens(2)), user('b')],
      [step('s1', tokens(1)), user('a')],
    ]);
    const firstPageBytes = Buffer.byteLength(JSON.stringify([step('s2', tokens(2)), user('b')]));

    const summary = await readSessionFollowupUsage(source, { maxBytes: firstPageBytes });

    expect(summary.complete).toBe(false);
    expect(summary.intervals.map((interval) => interval.promptIDs)).toEqual([['b']]);
  });

  it('reports admitted prompts that are still queued', async () => {
    const source = reader(
      [[user('a')]],
      [inboxItem('queued', 'user'), inboxItem('notice', 'synthetic')]
    );

    expect((await readSessionFollowupUsage(source)).pendingPromptIDs).toEqual(['queued']);
  });

  it('keeps newer pages when an older page exceeds the response limit', async () => {
    const pages = [[step('s2', tokens(2)), user('b'), step('s1', tokens(1))]];
    const source = {
      readInbox: async () => [],
      readPage: async (cursor: string | undefined): Promise<SessionMessagesResponse> => {
        if (cursor) throw new OpenCodeResponseTooLargeError(1024);
        return { data: pages[0]!, cursor: { next: 'older' } };
      },
    };

    const summary = await readSessionFollowupUsage(source);

    expect(summary.complete).toBe(false);
    expect(summary.intervals).toEqual([
      expect.objectContaining({ promptIDs: ['b'], usage: expect.objectContaining({ input: 2 }) }),
    ]);
    expect(summary.intervals[0]).not.toHaveProperty('boundaryUnknown');
  });

  it('does not swallow cancellation or other read failures', async () => {
    const source = {
      readInbox: async () => [],
      readPage: async (cursor: string | undefined): Promise<SessionMessagesResponse> => {
        if (cursor) throw new DOMException('Aborted', 'AbortError');
        return { data: [user('a')], cursor: { next: 'older' } };
      },
    };

    await expect(readSessionFollowupUsage(source)).rejects.toThrow('Aborted');
  });

  it('rejects a repeated pagination cursor', async () => {
    const source = {
      readInbox: async () => [],
      readPage: async () => ({ data: [user('a')], cursor: { next: 'same' } }),
    };

    await expect(readSessionFollowupUsage(source)).rejects.toThrow('repeated a message pagination');
  });
});
