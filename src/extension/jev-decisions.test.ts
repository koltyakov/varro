/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These tests drive the TypeSafe boundary with partial fetch and OpenCode fixtures. */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { AutoApproveJudge } from './auto-approve-judge';
import { HiddenSessionManager } from './hidden-session-manager';
import { JevApiError, JevClient, JevDecisions } from './jev-decisions';

const permission = {
  id: 'perm-1',
  type: 'bash',
  sessionID: 'session-1',
  title: 'Run command: cargo build',
  metadata: { command: 'cargo build' },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function permissionAnswers(options: {
  choice?: string;
  probability?: number;
  confidence?: number;
  destructive?: number;
  manipulation?: number;
}) {
  const choice = options.choice ?? 'allow';
  const probability = options.probability ?? 0.95;
  const rest = (1 - probability) / 2;
  const probabilities = { allow: rest, ask: rest, reject: rest, [choice]: probability };
  return {
    model: 'jev-1.13.0',
    answers: {
      decision: {
        type: 'choice',
        choice,
        probabilities,
        confidence: options.confidence ?? 0.9,
      },
      destructive: { type: 'noul', noul: options.destructive ?? 0.02 },
      manipulation: { type: 'noul', noul: options.manipulation ?? 0.01 },
    },
    usage: { input_tokens: 200, output_tokens: 3 },
  };
}

function createDecisions(fetchImpl: typeof fetch, apiKey: string | undefined = 'ts-key') {
  return new JevDecisions(
    new JevClient(async () => apiKey, fetchImpl),
    () => ({ autoApprove: true, model: 'jev-latest' }),
    async () => !!apiKey
  );
}

describe('JevClient', () => {
  it('posts typed questions to the System One endpoint with bearer auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ answers: { ok: { type: 'noul', noul: 0.97 } } })
    );
    const client = new JevClient(async () => 'ts-key', fetchImpl);

    const answers = await client.evaluate(
      'jev-latest',
      'state',
      { ok: { type: 'noul', instructions: 'Is this a check?' } },
      1_000
    );

    expect(answers.ok.noul).toBe(0.97);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ts-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'jev-latest',
      state: 'state',
      questions: { ok: { type: 'noul', instructions: 'Is this a check?' } },
    });
  });

  it('reports HTTP failures and malformed answers', async () => {
    const unauthorized = new JevClient(
      async () => 'bad',
      async () => jsonResponse({}, 401)
    );
    await expect(
      unauthorized.evaluate('jev-latest', 's', { q: { type: 'noul', instructions: 'q' } }, 1_000)
    ).rejects.toThrow('rejected the API key');

    const malformed = new JevClient(
      async () => 'ts-key',
      async () =>
        jsonResponse({
          answers: {
            q: { type: 'choice', choice: 'other', probabilities: { a: 1 }, confidence: 1 },
          },
        })
    );
    await expect(
      malformed.evaluate(
        'jev-latest',
        's',
        { q: { type: 'choice', instructions: 'q', criteria: { a: null } } },
        1_000
      )
    ).rejects.toBeInstanceOf(JevApiError);
  });

  it('refuses to call TypeSafe without an API key', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new JevClient(async () => undefined, fetchImpl);
    await expect(
      client.evaluate('jev-latest', 's', { q: { type: 'noul', instructions: 'q' } }, 1_000)
    ).rejects.toThrow('not configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('JevDecisions.judgePermission', () => {
  it('allows only confident, low-risk answers', async () => {
    const decisions = createDecisions(async () => jsonResponse(permissionAnswers({})));
    await expect(decisions.judgePermission(permission, [])).resolves.toMatchObject({
      decision: 'allow',
    });
  });

  it.each([
    ['low probability', { probability: 0.6 }],
    ['low confidence', { confidence: 0.5 }],
    ['possible side effects', { destructive: 0.4 }],
    ['steering text', { manipulation: 0.5 }],
  ])('asks on %s', async (_label, options) => {
    const decisions = createDecisions(async () => jsonResponse(permissionAnswers(options)));
    await expect(decisions.judgePermission(permission, [])).resolves.toMatchObject({
      decision: 'ask',
    });
  });

  it('rejects only when the user rejected a matching action before', async () => {
    const decisions = createDecisions(async () =>
      jsonResponse(permissionAnswers({ choice: 'reject', probability: 0.96 }))
    );
    await expect(decisions.judgePermission(permission, [])).resolves.toMatchObject({
      decision: 'ask',
    });
    await expect(
      decisions.judgePermission(permission, [
        { type: 'bash', title: 'Run command: cargo build', response: 'reject' },
      ])
    ).resolves.toMatchObject({ decision: 'reject' });
  });
});

function createJudge(jev: ConstructorParameters<typeof AutoApproveJudge>[5]) {
  const request = vi.fn(async (method: string, path: string) => {
    if (method === 'GET' && path === '/config') return {};
    if (method === 'GET' && path === '/config/providers') return { providers: [] };
    if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
    if (method === 'POST' && path === '/session/judge-session-1/message') {
      return { info: { structured: { decision: 'ask', reason: 'Model judge.' } } };
    }
    if (method === 'DELETE' && path === '/session/judge-session-1') return true;
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  const judge = new AutoApproveJudge(
    { request } as never,
    new HiddenSessionManager(),
    async () => false,
    () => null,
    async () => null,
    jev
  );
  return { judge, request };
}

describe('AutoApproveJudge with Jev', () => {
  const npmPublish = {
    ...permission,
    title: 'Run command: npm publish',
    metadata: { command: 'npm publish' },
  };

  it('uses Jev instead of a hidden model session and caches its verdict', async () => {
    const judgePermission = vi.fn(async () => ({ decision: 'allow' as const, reason: 'Jev' }));
    const { judge, request } = createJudge({
      isAutoApproveEnabled: async () => true,
      judgePermission,
      model: { providerID: 'typesafe', modelID: 'jev-latest' },
    });

    const reviewerModel = { providerID: 'typesafe', modelID: 'jev-latest' };
    await expect(judge.judge({ permission: npmPublish })).resolves.toMatchObject({
      decision: 'allow',
      reviewerModel,
    });
    // Cached verdicts keep the reviewer that produced them.
    await expect(judge.judge({ permission: npmPublish })).resolves.toMatchObject({
      decision: 'allow',
      reviewerModel,
    });
    expect(judgePermission).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    await expect(judge.resolveModel(undefined)).resolves.toEqual({
      providerID: 'typesafe',
      modelID: 'jev-latest',
    });
  });

  it('falls back to the model judge when Jev fails', async () => {
    const { judge, request } = createJudge({
      isAutoApproveEnabled: async () => true,
      judgePermission: async () => {
        throw new JevApiError('TypeSafe rate limit reached (429)', 429);
      },
      model: { providerID: 'typesafe', modelID: 'jev-latest' },
    });

    await expect(judge.judge({ permission: npmPublish })).resolves.toMatchObject({
      decision: 'ask',
      reason: 'Model judge.',
    });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.anything());
  });

  it('skips Jev when auto-approve is not enabled for it', async () => {
    const judgePermission = vi.fn();
    const { judge, request } = createJudge({
      isAutoApproveEnabled: async () => false,
      judgePermission,
      model: { providerID: 'typesafe', modelID: 'jev-latest' },
    });

    await judge.judge({ permission: npmPublish });
    expect(judgePermission).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.anything());
  });
});
