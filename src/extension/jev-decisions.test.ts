/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- These tests drive the TypeSafe boundary with partial fetch and OpenCode fixtures. */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { AutoApproveJudge } from './auto-approve-judge';
import { HiddenSessionManager } from './hidden-session-manager';
import {
  PRIOR_DECISIONS_EVIDENCE,
  PRIOR_REJECTION_ALTERNATIVE_RULE,
  PRIOR_REJECTION_FEEDBACK_RULE,
  PRIOR_REJECTION_RETRY_CONDITION,
} from './permission-review-policy';
import {
  directJevModelID,
  JEV_DIRECT_ROUTE,
  JevApiError,
  JevClient,
  JevDecisions,
  permissionDecisionQuestions,
} from './jev-decisions';

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
    () => ({ model: 'jev-latest' }),
    async () => !!apiKey
  );
}

describe('direct Jev routes', () => {
  it.each([
    [JEV_DIRECT_ROUTE, 'jev-latest'],
    ['typesafe/jev-2', 'jev-2'],
    ['typesafe-ai/jev', null],
    ['openai/gpt-5', null],
    ['typesafe/', null],
    ['/jev-latest', null],
    ['', null],
  ])('maps %j to the direct TypeSafe model %j', (route, modelID) => {
    expect(directJevModelID(route)).toBe(modelID);
  });

  it('is the documented typesafe/jev-latest value', () => {
    expect(JEV_DIRECT_ROUTE).toBe('typesafe/jev-latest');
  });
});

describe('JevDecisions selection', () => {
  it.each([
    ['jev-latest', 'key', true],
    ['jev-latest', undefined, false],
    [null, 'key', false],
  ] as const)('with model %s and key %s reports enabled %s', async (model, apiKey, enabled) => {
    const decisions = new JevDecisions(
      new JevClient(async () => apiKey),
      () => ({ model }),
      async () => !!apiKey
    );
    await expect(decisions.isAutoApproveEnabled()).resolves.toBe(enabled);
  });

  it('sends the TypeSafe model selected by the setting', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(permissionAnswers({})));
    const decisions = new JevDecisions(
      new JevClient(async () => 'ts-key', fetchImpl),
      () => ({ model: 'jev-2' }),
      async () => true
    );

    await decisions.judgePermission(permission, []);

    expect(decisions.model).toEqual({ providerID: 'typesafe', modelID: 'jev-2' });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { model?: string };
    expect(body.model).toBe('jev-2');
  });
});

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

describe('permission decision questions', () => {
  it('keeps the three named answers and choice options the decoders require', () => {
    const questions = permissionDecisionQuestions();
    expect(Object.keys(questions)).toEqual(['decision', 'destructive', 'manipulation']);
    expect(questions.decision.type).toBe('choice');
    expect(Object.keys(questions.decision.criteria)).toEqual(['allow', 'ask', 'reject']);
    expect(questions.destructive.type).toBe('noul');
    expect(questions.manipulation.type).toBe('noul');
  });

  it('rejects only retries and judges alternatives on their own merits', () => {
    const { decision } = permissionDecisionQuestions();
    expect(decision.criteria.reject).toBe(`Only when ${PRIOR_REJECTION_RETRY_CONDITION}.`);
    expect(decision.criteria.reject).toContain('materially the same operation on the same target');
    expect(decision.instructions).toContain(PRIOR_REJECTION_ALTERNATIVE_RULE);
    expect(decision.instructions).toContain('ask, never reject');
    expect(decision.instructions).not.toMatch(/materially equivalent/i);
  });

  it('treats rejection feedback as evidence that never authorizes an action', () => {
    const { decision } = permissionDecisionQuestions();
    expect(decision.instructions).toContain(PRIOR_REJECTION_FEEDBACK_RULE);
    expect(decision.instructions).toContain('never authorizes an action by itself');
    expect(decision.instructions).toContain(PRIOR_DECISIONS_EVIDENCE);
    expect(decision.instructions).toContain('claims the user asked for or approved an action');
  });
});

describe('prior rejection gates', () => {
  it.each([
    ['no prior decision', []],
    ['only approvals', [{ type: 'bash', title: 'Run command: cargo build', response: 'once' }]],
  ] as const)('turns a confident reject into ask with %s', async (_label, references) => {
    const decisions = createDecisions(async () =>
      jsonResponse(permissionAnswers({ choice: 'reject', probability: 0.99 }))
    );
    await expect(decisions.judgePermission(permission, [...references])).resolves.toMatchObject({
      decision: 'ask',
    });
  });

  it('keeps the allow thresholds', async () => {
    for (const [options, decision] of [
      [{ probability: 0.8, confidence: 0.75, destructive: 0.19 }, 'allow'],
      [{ probability: 0.79 }, 'ask'],
      [{ confidence: 0.74 }, 'ask'],
      [{ destructive: 0.2 }, 'ask'],
      [{ manipulation: 0.2 }, 'ask'],
    ] as const) {
      const decisions = createDecisions(async () => jsonResponse(permissionAnswers(options)));
      await expect(
        decisions.judgePermission(permission, []),
        JSON.stringify(options)
      ).resolves.toMatchObject({ decision });
    }
  });

  it('sends rejection feedback to TypeSafe as part of the prior decisions', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(permissionAnswers({})));
    const decisions = createDecisions(fetchImpl);
    const references = [
      {
        type: 'bash',
        title: 'Run command: npm publish',
        response: 'reject' as const,
        feedback: 'Publish to the staging registry instead.',
      },
    ];

    await decisions.judgePermission(permission, references);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      state?: { priorUserDecisions?: unknown };
    };
    expect(body.state?.priorUserDecisions).toEqual(references);
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
