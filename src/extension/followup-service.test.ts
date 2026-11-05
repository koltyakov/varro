/* oxlint-disable anti-slop/no-module-mocking -- The optional inference boundary is tested without contacting a provider. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeServer } from './server';
import { FollowupService } from './followup-service';
import { FollowupCache } from './followup-cache';
import { logger } from './logger';
import { EMPTY_FOLLOWUP_SUGGESTIONS } from '../shared/followups';
import type { Persistence } from '../shared/persistence';

vi.mock('./logger', () => ({ logger: { info: vi.fn() } }));

const source = {
  assistantMessageId: 'answer',
  userMessageId: 'user',
  userPrompt: 'Fix the parser',
  answer: 'The empty-token bug remains.',
};
const actions = [
  {
    title: 'Fix empty tokens',
    prompt: 'Fix only the reported empty-token parser bug and add a regression test.',
  },
];
const summary =
  'The empty-token parser issue is still unresolved. A focused fix and regression test would address the reported failure without unrelated changes.';
const suggestions = { summary, actions };
let directory: string;

beforeEach(async () => {
  const parent = resolvePath('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(join(parent, 'followup-service-'));
  vi.stubEnv('VARRO_TEST_STATE_ROOT', directory);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function setup() {
  let currentAnswer = source.answer;
  let currentUserPrompt = source.userPrompt;
  let status = 'idle';
  let agent: string | undefined = 'build';
  let mode: string | undefined = 'build';
  let output = JSON.stringify(suggestions);
  const request = vi.fn<OpenCodeServer['request']>().mockImplementation(async (_method, path) => {
    if (path === '/openapi.json') return { paths: { '/api/experimental/generate': { post: {} } } };
    if (path === '/api/experimental/generate') return { data: { text: output } };
    if (path === '/session/status') return { s: { type: status } };
    if (path === '/session/s/message/user')
      return {
        info: { id: 'user', sessionID: 's', role: 'user' },
        parts: [{ type: 'text', text: currentUserPrompt }],
      };
    if (path === '/session/s/message?limit=2')
      return [
        {
          info: {
            id: 'answer',
            sessionID: 's',
            role: 'assistant',
            agent,
            mode,
            parentID: 'user',
            finish: 'stop',
            time: { completed: 2 },
          },
          parts: [{ type: 'text', text: currentAnswer }],
        },
      ];
    throw new Error(`Unexpected request: ${path}`);
  });
  const server: Pick<OpenCodeServer, 'request' | 'apiVersion'> = { apiVersion: 2, request };
  const input = {
    sessionId: 's',
    allowGenerate: true,
    source,
    model: { providerID: 'provider', modelID: 'small' },
    directory: '/repo',
    isModelCurrent: () => true,
  };
  return {
    server,
    request,
    input,
    setAgent: (value: string | undefined, legacyMode: string | undefined = value) => {
      agent = value;
      mode = legacyMode;
    },
    setAnswer: (value: string) => {
      currentAnswer = value;
    },
    setUserPrompt: (value: string) => {
      currentUserPrompt = value;
    },
    setStatus: (value: string) => {
      status = value;
    },
    setOutput: (value: string) => {
      output = value;
    },
  };
}

describe('FollowupService', () => {
  it('returns cached suggestions without admitting generation for an opening cache probe', async () => {
    const { server, request, input } = setup();
    const service = new FollowupService(server);
    expect(await service.suggest(input)).toEqual(suggestions);
    request.mockClear();
    expect(await service.suggest({ ...input, cacheOnly: true, allowGenerate: false })).toEqual(
      suggestions
    );
    expect(request.mock.calls.some(([, path]) => path === '/api/experimental/generate')).toBe(
      false
    );
  });

  it('returns an opening cache miss without generating even when generation is allowed', async () => {
    const { server, request, input } = setup();
    expect(await new FollowupService(server).suggest({ ...input, cacheOnly: true })).toEqual(
      EMPTY_FOLLOWUP_SUGGESTIONS
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('does not wait for pending same-host or other-host generation during an opening cache probe', async () => {
    const { server, request, input } = setup();
    const original = request.getMockImplementation()!;
    let finish!: (value: { data: { text: string } }) => void;
    request.mockImplementation((...args) =>
      args[1] === '/api/experimental/generate'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args)
    );
    const service = new FollowupService(server);
    const pending = service.suggest(input);
    await vi.waitFor(() => expect(finish).toBeDefined());
    for (const reader of [service, new FollowupService(server)]) {
      expect(await reader.suggest({ ...input, cacheOnly: true })).toEqual(
        EMPTY_FOLLOWUP_SUGGESTIONS
      );
    }
    finish({ data: { text: JSON.stringify(suggestions) } });
    expect(await pending).toEqual(suggestions);
    expect(
      request.mock.calls.filter(([, path]) => path === '/api/experimental/generate')
    ).toHaveLength(1);
  });

  it('waits for another host to complete a pending admission without generating twice', async () => {
    const { server, request, input } = setup();
    const original = request.getMockImplementation()!;
    let finish!: (value: { data: { text: string } }) => void;
    request.mockImplementation((...args) =>
      args[1] === '/api/experimental/generate'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args)
    );
    const first = new FollowupService(server).suggest(input);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const reads = vi.spyOn(FollowupCache.prototype, 'getState');
    const second = new FollowupService(server).suggest({ ...input, allowGenerate: false });
    await vi.waitFor(async () => expect(await reads.mock.results[0]?.value).toBe('pending'));
    finish({ data: { text: JSON.stringify(suggestions) } });
    expect(await first).toEqual(suggestions);
    expect(await second).toEqual(suggestions);
    expect(
      request.mock.calls.filter(([, path]) => path === '/api/experimental/generate')
    ).toHaveLength(1);
  });

  it('finishes an admitted generation for another host after the originating editor closes', async () => {
    const { server, request, input } = setup();
    const original = request.getMockImplementation()!;
    let finish!: (value: { data: { text: string } }) => void;
    request.mockImplementation((...args) =>
      args[1] === '/api/experimental/generate'
        ? new Promise((resolve, reject) => {
            finish = resolve;
            args[3]?.signal?.addEventListener('abort', () => reject(args[3]?.signal?.reason), {
              once: true,
            });
          })
        : original(...args)
    );
    const controller = new AbortController();
    const first = new FollowupService(server).suggest({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const reads = vi.spyOn(FollowupCache.prototype, 'getState');
    reads.mockClear();
    const second = new FollowupService({ ...server }).suggest({ ...input, allowGenerate: false });
    await vi.waitFor(async () => expect(await reads.mock.results[0]?.value).toBe('pending'));
    controller.abort();
    const generation = request.mock.calls.find(([, path]) => path === '/api/experimental/generate');
    expect(generation?.[3]?.signal?.aborted).toBe(false);
    finish({ data: { text: JSON.stringify(suggestions) } });
    expect(await first).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await second).toEqual(suggestions);
    expect(
      request.mock.calls.filter(([, path]) => path === '/api/experimental/generate')
    ).toHaveLength(1);
  });

  it('retries a turn when its only subscriber cancels before admission', async () => {
    const { server, request, input } = setup();
    const original = request.getMockImplementation()!;
    let waiting = false;
    request.mockImplementation((...args) => {
      if (args[1] === '/session/status' && !waiting) {
        waiting = true;
        return new Promise((_resolve, reject) => {
          args[3]?.signal?.addEventListener('abort', () => reject(args[3]?.signal?.reason), {
            once: true,
          });
        });
      }
      return original(...args);
    });
    const service = new FollowupService(server);
    const controller = new AbortController();
    const first = service.suggest({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(waiting).toBe(true));
    controller.abort();
    const second = service.suggest(input);
    expect(await first).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await second).toEqual(suggestions);
    expect(
      request.mock.calls.filter(([, path]) => path === '/api/experimental/generate')
    ).toHaveLength(1);
  });

  it('retries after a transient pre-admission source mismatch', async () => {
    const { server, request, input, setAnswer } = setup();
    const service = new FollowupService(server);
    setAnswer('Temporarily out of date');
    expect(await service.suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    setAnswer(source.answer);
    expect(await service.suggest(input)).toEqual(suggestions);
    expect(
      request.mock.calls.filter(([, path]) => path === '/api/experimental/generate')
    ).toHaveLength(1);
  });

  it('preserves the selected reasoning variant in stateless generation', async () => {
    const { server, request, input } = setup();
    expect(
      await new FollowupService(server).suggest({
        ...input,
        model: { ...input.model, variant: 'high' },
      })
    ).toEqual(suggestions);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/experimental/generate',
      expect.objectContaining({ model: { providerID: 'provider', id: 'small', variant: 'high' } }),
      expect.any(Object)
    );
  });

  it('requests actions ordered by recommendation, considering relevance, impact, and prerequisites', async () => {
    const { server, request, input } = setup();
    expect(await new FollowupService(server).suggest(input)).toEqual(suggestions);
    const body = request.mock.calls.find(([, path]) => path === '/api/experimental/generate')?.[2];
    expect(body).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'Order actions from most recommended to least, considering relevance to the user goal, expected impact, and prerequisites.'
        ),
      })
    );
  });

  it('requests summary, titles, and prompts in the response language rather than the request language', async () => {
    const { server, request, input, setAnswer, setOutput } = setup();
    const answer = 'Der Fehler bei leeren Tokens besteht weiterhin.';
    const localizedSuggestions = {
      summary:
        'Der Parser verarbeitet leere Tokens noch nicht korrekt. Eine gezielte Korrektur mit einem Regressionstest würde den verbleibenden Fehler beheben.',
      actions: [
        {
          title: 'Leere Tokens korrigieren',
          prompt:
            'Behebe nur den gemeldeten Parserfehler bei leeren Tokens und ergänze einen Regressionstest.',
        },
      ],
    };
    setAnswer(answer);
    setOutput(JSON.stringify(localizedSuggestions));
    expect(
      await new FollowupService(server).suggest({ ...input, source: { ...source, answer } })
    ).toEqual(localizedSuggestions);
    const body = request.mock.calls.find(([, path]) => path === '/api/experimental/generate')?.[2];
    expect(body).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'Write the summary, action titles, and action prompts in the same language as finalAnswer, even when userRequest is in a different language. Keep the JSON property names unchanged.'
        ),
      })
    );
    expect(body).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining(
          JSON.stringify({ userRequest: source.userPrompt, finalAnswer: answer })
        ),
      })
    );
  });

  it('clears old suggestion content on the next accepted turn without allowing old-turn regeneration', async () => {
    const { server, request, input } = setup();
    const service = new FollowupService(server);
    await service.suggest(input);
    await service.clearPreviousTurn({
      sessionId: 's',
      directory: '/repo',
      userMessageId: 'next-user',
    });
    expect(await service.suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('does not clear another session or the newly accepted turn', async () => {
    const { server, input } = setup();
    const service = new FollowupService(server);
    await service.suggest(input);
    await service.clearPreviousTurn({ sessionId: 'another', directory: '/repo' });
    await service.clearPreviousTurn({ sessionId: 's', directory: '/repo', userMessageId: 'user' });
    expect(await service.suggest({ ...input, allowGenerate: false })).toEqual(suggestions);
  });
  it('defaults to cache-only retrieval for old history', async () => {
    const { server, request, input } = setup();
    expect(
      await new FollowupService(server).suggest({ ...input, allowGenerate: undefined })
    ).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['ready', 'empty', 'invalid', 'dismissed', 'cleared'])(
    'persists %s outcomes across restart, invalidation, and model changes',
    async (kind) => {
      const { server, request, input, setOutput } = setup();
      const storage = new Map<string, unknown>();
      const persistence = (): Persistence => ({
        // SAFETY: Only FollowupCache writes this in-memory persistence fixture.
        get: <T>(key: string) => structuredClone(storage.get(key)) as T | undefined,
        set: (key, value) => {
          storage.set(key, structuredClone(value));
        },
        remove: (key) => {
          storage.delete(key);
        },
      });
      if (kind === 'empty') setOutput(JSON.stringify(EMPTY_FOLLOWUP_SUGGESTIONS));
      if (kind === 'invalid') setOutput('invalid json');
      const first = new FollowupService(server, persistence());
      await first.suggest(input);
      if (kind === 'dismissed') await first.dismiss(input);
      if (kind === 'cleared') {
        await first.clearPreviousTurn({
          sessionId: 's',
          directory: '/repo',
          userMessageId: 'next-user',
        });
        expect(JSON.stringify([...storage.values()])).not.toContain(summary);
        expect(JSON.stringify([...storage.values()])).not.toContain(actions[0]!.prompt);
      }
      first.invalidate();
      const restarted = new FollowupService(server, persistence());
      const expected = kind === 'ready' ? suggestions : EMPTY_FOLLOWUP_SUGGESTIONS;
      expect(
        await restarted.suggest({
          ...input,
          allowGenerate: false,
          model: { providerID: 'other', modelID: 'other' },
        })
      ).toEqual(expected);
      expect(await restarted.suggest(input)).toEqual(expected);
      expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    }
  );

  it.each(['dismissed', 'new-prompt', 'used-action'])(
    'clears stored suggestion text after %s and never restores it in another editor',
    async (action) => {
      const { server, request, input } = setup();
      const service = new FollowupService(server);
      expect(await service.suggest(input)).toEqual(suggestions);
      if (action === 'new-prompt')
        await service.clearPreviousTurn({
          sessionId: input.sessionId,
          directory: input.directory,
          userMessageId: 'next-user',
        });
      else await service.dismiss(input);
      const stored = await readFile(join(directory, 'followups', 'cache.json'), 'utf8');
      expect(stored).not.toContain(summary);
      expect(stored).not.toContain(actions[0]!.prompt);
      const reopened = new FollowupService({ ...server });
      expect(await reopened.suggest({ ...input, allowGenerate: false })).toEqual(
        EMPTY_FOLLOWUP_SUGGESTIONS
      );
      expect(await reopened.suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    }
  );

  it('admits only one inference across services without shared workspace state', async () => {
    const { server, request, input } = setup();
    const results = await Promise.all([
      new FollowupService(server).suggest(input),
      new FollowupService({ ...server }).suggest(input),
    ]);
    expect(results.some((result) => result.actions.length > 0)).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect(await new FollowupService({ ...server }).suggest(input)).toEqual(suggestions);
  });

  it('does not regenerate an edited source in the same user turn', async () => {
    const { server, request, input, setAnswer } = setup();
    const service = new FollowupService(server);
    await service.suggest(input);
    service.invalidate();
    setAnswer('Edited answer');
    expect(
      await service.suggest({ ...input, source: { ...source, answer: 'Edited answer' } })
    ).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('shares durable admission between separate editor services', async () => {
    const { server, request, input } = setup();
    const storage = new Map<string, unknown>();
    const persistence: Persistence = {
      // SAFETY: Only FollowupCache writes this in-memory persistence fixture.
      get: <T>(key: string) => structuredClone(storage.get(key)) as T | undefined,
      set: (key, value) => {
        storage.set(key, structuredClone(value));
      },
      remove: (key) => {
        storage.delete(key);
      },
    };
    const results = await Promise.all([
      new FollowupService(server, persistence).suggest(input),
      new FollowupService({ ...server }, persistence).suggest(input),
    ]);
    expect(results).toEqual([suggestions, suggestions]);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it.each([false, true])(
    'shares in-flight suggestions across services with shared persistence, allowGenerate=%s',
    async (allowGenerate) => {
      const { server, request, input } = setup();
      const storage = new Map<string, unknown>();
      const persistence: Persistence = {
        // SAFETY: Only FollowupCache writes this in-memory persistence fixture.
        get: <T>(key: string) => structuredClone(storage.get(key)) as T | undefined,
        set: (key, value) => {
          storage.set(key, structuredClone(value));
        },
        remove: (key) => {
          storage.delete(key);
        },
      };
      let finish!: (value: { data: { text: string } }) => void;
      const original = request.getMockImplementation()!;
      request.mockImplementation((...args) =>
        args[1] === '/api/experimental/generate'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : original(...args)
      );
      const firstService = new FollowupService(server, persistence);
      const secondService = new FollowupService({ ...server }, persistence);
      const controller = new AbortController();
      const first = firstService.suggest({ ...input, signal: controller.signal });
      await vi.waitFor(() => expect(finish).toBeDefined());
      const second = secondService.suggest({ ...input, allowGenerate });
      controller.abort();
      const generation = request.mock.calls.find(
        ([, path]) => path === '/api/experimental/generate'
      );
      const generationAborted = generation?.[3]?.signal?.aborted;
      finish({ data: { text: JSON.stringify(suggestions) } });
      expect(await first).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(await second).toEqual(suggestions);
      expect(generationAborted).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    }
  );

  it('does not infer if admission cannot be persisted', async () => {
    const { server, request, input } = setup();
    await writeFile(join(directory, 'followups'), 'Not a writable directory');
    expect(await new FollowupService(server).suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(request.mock.calls.some(([method]) => method === 'POST')).toBe(false);
  });
  it.each(['ask', 'plan', 'review', 'custom', undefined])(
    'does not infer for non-Build agent %s, even if the client requests it',
    async (agent) => {
      const { server, request, input, setAgent } = setup();
      setAgent(agent);
      expect(await new FollowupService(server).suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(request.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    }
  );

  it('does not let a legacy Build mode override an explicit Ask agent', async () => {
    const { server, request, input, setAgent } = setup();
    setAgent('ask', 'build');
    expect(await new FollowupService(server).suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(request.mock.calls.some(([method]) => method === 'POST')).toBe(false);
  });

  it('accepts an explicitly identified legacy Build response', async () => {
    const { server, input, setAgent } = setup();
    setAgent(undefined, 'build');
    expect(await new FollowupService(server).suggest(input)).toEqual(suggestions);
  });

  it('waits for backend idle after the UI settles instead of caching premature abstention', async () => {
    const { server, request, input } = setup();
    const original = request.getMockImplementation()!;
    let snapshots = 0;
    request.mockImplementation((...args) => {
      if (args[1] === '/session/status' && snapshots++ === 0)
        return Promise.resolve({ s: { type: 'busy' } });
      return original(...args);
    });
    expect(await new FollowupService(server).suggest(input)).toEqual(suggestions);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect(snapshots).toBeGreaterThan(1);
  });

  it('requests separately authorized fixes after a read-only review reports defects', async () => {
    const { server, request, input, setUserPrompt, setAnswer, setOutput } = setup();
    const reviewSource = {
      ...source,
      userPrompt: 'Review the changes',
      answer:
        'Found two issues: completed history can trigger inference, and dismissal shifts detached readers.',
    };
    const reviewActions = [
      {
        title: 'Fix reported issues',
        prompt:
          'Fix only the two reported follow-up defects and add focused regression tests. Preserve normal permission checks.',
      },
    ];
    setUserPrompt(reviewSource.userPrompt);
    setAnswer(reviewSource.answer);
    const reviewSuggestions = {
      summary:
        'The review found two defects in follow-up behavior. Fixing the reported cases and adding regression tests would address both findings.',
      actions: reviewActions,
    };
    setOutput(JSON.stringify(reviewSuggestions));
    expect(await new FollowupService(server).suggest({ ...input, source: reviewSource })).toEqual(
      reviewSuggestions
    );
    const body = request.mock.calls.find(([method]) => method === 'POST')?.[2];
    expect(body).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'A review that reports actionable defects can suggest "Fix reported issues"'
        ),
      })
    );
    expect(body).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining('Each suggestion requires separate user consent'),
      })
    );
    expect(body).toEqual(
      expect.objectContaining({ prompt: expect.not.stringContaining('when complete, read-only') })
    );
  });

  it('allows an assigned model more than eight seconds without retrying or switching providers', async () => {
    vi.useFakeTimers();
    const { server, request, input } = setup();
    let finish!: (value: { data: { text: string } }) => void;
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) =>
      args[1] === '/api/experimental/generate'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args)
    );
    try {
      const pending = new FollowupService(server).suggest(input);
      await vi.waitFor(() => expect(finish).toBeDefined());
      await vi.advanceTimersByTimeAsync(10_000);
      const generation = request.mock.calls.find(
        ([, path]) => path === '/api/experimental/generate'
      );
      expect(generation?.[3]?.signal?.aborted).toBe(false);
      finish({ data: { text: JSON.stringify(suggestions) } });
      expect(await pending).toEqual(suggestions);
      expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a bounded timeout separately from abstention without leaking conversation text', async () => {
    vi.useFakeTimers();
    const { server, request, input } = setup();
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) =>
      args[1] === '/api/experimental/generate'
        ? new Promise((_resolve, reject) => {
            args[3]?.signal?.addEventListener('abort', () => reject(args[3]?.signal?.reason), {
              once: true,
            });
          })
        : original(...args)
    );
    vi.mocked(logger.info).mockClear();
    try {
      const service = new FollowupService(server);
      const pending = service.suggest(input);
      await vi.waitFor(() =>
        expect(request.mock.calls.some(([, path]) => path === '/api/experimental/generate')).toBe(
          true
        )
      );
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await pending).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(logger.info).toHaveBeenCalledWith(
        'Follow-ups failed',
        expect.objectContaining({ reason: 'timeout' })
      );
      expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(source.userPrompt);
      expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(source.answer);
      expect(await service.suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records an empty model result as abstention rather than failure', async () => {
    const { server, input, setOutput } = setup();
    setOutput(JSON.stringify(EMPTY_FOLLOWUP_SUGGESTIONS));
    vi.mocked(logger.info).mockClear();
    expect(await new FollowupService(server).suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(logger.info).toHaveBeenCalledWith('Follow-ups generation completed', {
      outcome: 'abstained',
      actionCount: 0,
    });
  });
  it('uses the assigned model through stateless generation without creating or mutating sessions', async () => {
    const { server, request, input } = setup();
    const service = new FollowupService(server);
    expect(await service.suggest(input)).toEqual(suggestions);
    const posts = request.mock.calls.filter(([method]) => method !== 'GET');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual([
      'POST',
      '/api/experimental/generate',
      {
        prompt: expect.stringContaining(
          JSON.stringify({ userRequest: source.userPrompt, finalAnswer: source.answer })
        ),
        model: { providerID: 'provider', id: 'small', variant: undefined },
      },
      expect.objectContaining({
        directory: '/repo',
        signal: expect.any(AbortSignal),
        maxResponseBytes: 16 * 1024,
      }),
    ]);
    expect(await service.suggest(input)).toEqual(suggestions);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect(FollowupService.forServer(server)).toBe(FollowupService.forServer(server));
  });

  it('does nothing without opt-in or V2', async () => {
    const { server, request, input } = setup();
    const service = new FollowupService(server);
    expect(await service.suggest({ ...input, isModelCurrent: () => false })).toEqual(
      EMPTY_FOLLOWUP_SUGGESTIONS
    );
    expect(await new FollowupService({ ...server, apiVersion: 1 }).suggest(input)).toEqual(
      EMPTY_FOLLOWUP_SUGGESTIONS
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['busy', 'changed', 'invalid', 'unavailable'])(
    'abstains for %s without fallback or retries',
    async (kind) => {
      const { server, request, input, setAnswer, setStatus, setOutput } = setup();
      if (kind === 'busy') setStatus('busy');
      if (kind === 'changed') setAnswer('Already fixed.');
      if (kind === 'invalid') setOutput('run tools instead');
      if (kind === 'unavailable') {
        const original = request.getMockImplementation()!;
        request.mockImplementation((...args) =>
          args[1] === '/openapi.json' ? Promise.resolve({ paths: {} }) : original(...args)
        );
      }
      const service = new FollowupService(server);
      expect(await service.suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(await service.suggest(input)).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
      expect(request.mock.calls.filter(([method]) => method === 'POST').length).toBeLessThanOrEqual(
        1
      );
    }
  );

  it('coalesces two views, permits subscriber cancellation, and rejects stale postconditions', async () => {
    const { server, request, input, setAnswer } = setup();
    let finish!: (value: { data: { text: string } }) => void;
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) =>
      args[1] === '/api/experimental/generate'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(...args)
    );
    const service = new FollowupService(server);
    const controller = new AbortController();
    const first = service.suggest({ ...input, signal: controller.signal });
    const second = service.suggest(input);
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort();
    const generation = request.mock.calls.find(([, path]) => path === '/api/experimental/generate');
    expect(generation?.[3]?.signal?.aborted).toBe(false);
    setAnswer('Changed during generation');
    finish({ data: { text: JSON.stringify(suggestions) } });
    expect(await first).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await second).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });
});
