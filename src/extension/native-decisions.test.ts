/* oxlint-disable anti-slop/no-module-mocking -- The server and logger boundaries are deterministic; decision gates and judge orchestration are real. */
import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeServer } from './server';
import { NativeDecisions } from './native-decisions';
import { AutoApproveJudge } from './auto-approve-judge';
import { HiddenSessionManager } from './hidden-session-manager';
import { asRecord, type JsonValue } from '../shared/type-utils';
import * as extensionConfig from './extension-config';
import { configurePromptTrace } from './prompt-trace';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const path = '/api/experimental/generate/decisions';
const model = { providerID: 'typesafe-ai', modelID: 'jev-latest' };
const permission = {
  id: 'perm_test',
  sessionID: 'ses_test',
  type: 'bash',
  metadata: { command: 'cargo build' },
};

function answers(
  options: {
    choice?: string;
    probability?: number;
    confidence?: number;
    risk?: number;
    manipulation?: number;
  } = {}
) {
  const choice = options.choice ?? 'allow';
  return [
    {
      name: 'decision',
      type: 'choice',
      choice,
      confidence: options.confidence ?? 0.9,
      probabilities: ['allow', 'ask', 'reject'].map((value) => ({
        value,
        probability: value === choice ? (options.probability ?? 0.95) : 0.025,
      })),
    },
    { name: 'destructive', type: 'predicate', probability: options.risk ?? 0.01 },
    { name: 'manipulation', type: 'predicate', probability: options.manipulation ?? 0.01 },
  ] satisfies [JsonValue, JsonValue, JsonValue];
}

function fixture(value: (JsonValue | undefined)[] = answers()) {
  const request = vi.fn<OpenCodeServer['request']>(async (method, route) => {
    if (route === '/openapi.json') return { paths: { [path]: { post: {} } } };
    if (route === '/api/model?types=decision')
      return {
        data: [
          { providerID: 'typesafe-ai', id: 'jev-latest', type: 'decision', name: 'Jev' },
          { providerID: 'test', id: 'chat', type: 'chat', name: 'Chat' },
        ],
      };
    if (route === path) return { data: { answers: value } };
    if (route === '/config') return {};
    if (route === '/config/providers') return { providers: [] };
    if (route === '/session' && method === 'POST') return { id: 'ses_judge' };
    if (route === '/session/ses_judge/message')
      return { info: { structured: { decision: 'ask' } } };
    if (route === '/session/ses_judge' && method === 'DELETE') return true;
    throw new Error(`Unexpected request ${method} ${route}`);
  });
  const server = { request, apiVersion: 2 as const };
  const native = new NativeDecisions(server, () => 'typesafe-ai/jev-latest');
  return { native, request, server };
}

describe('native permission decisions', () => {
  it('traces native permission evidence without changing decision questions or gates', async () => {
    const trace = vi.spyOn(extensionConfig, 'readPromptTrace').mockReturnValue(true);
    configurePromptTrace(extensionConfig.readPromptTrace);
    const { native, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) =>
      args[1] === '/session/ses_test' ? Promise.resolve({ id: 'ses_test' }) : original(...args)
    );
    try {
      expect(await native.judgePermission(model, permission, [])).toMatchObject({
        decision: 'allow',
      });
      expect(request).toHaveBeenCalledWith(
        'POST',
        path,
        expect.objectContaining({
          input: [
            {
              type: 'text',
              text: `VARRO_TRACE_V1 {"purpose":"permission-judge","sessionID":"ses_test","rootSessionID":"ses_test","requestID":"perm_test"}\n${JSON.stringify({ permission, priorUserDecisions: [] })}`,
            },
          ],
          questions: expect.arrayContaining([
            expect.objectContaining({ name: 'decision' }),
            expect.objectContaining({ name: 'destructive' }),
            expect.objectContaining({ name: 'manipulation' }),
          ]),
        }),
        expect.any(Object)
      );
      expect(request.mock.calls.filter(([method]) => method !== 'GET')).toHaveLength(1);
    } finally {
      trace.mockRestore();
      configurePromptTrace(() => false);
    }
  });

  it('discovers only decision models and submits evidence without creating sessions', async () => {
    const { native, request } = fixture();
    expect(await native.status()).toMatchObject({
      supported: true,
      model,
      models: [{ ...model, name: 'Jev' }],
    });
    expect((await native.status()).models).toHaveLength(1);
    expect(await native.judgePermission(model, permission, [])).toMatchObject({
      decision: 'allow',
    });
    const call = request.mock.calls.find(([method]) => method === 'POST');
    expect(call?.[1]).toBe(path);
    expect(asRecord(call?.[2])?.model).toEqual({ providerID: model.providerID, id: model.modelID });
    expect(call?.[3]).toMatchObject({
      unscoped: true,
      signal: expect.any(AbortSignal),
      maxResponseBytes: 65536,
    });
    expect(request.mock.calls.some(([, route]) => route.includes('/session'))).toBe(false);
  });
  it.each([{ probability: 0.79 }, { confidence: 0.74 }, { risk: 0.2 }, { manipulation: 0.2 }])(
    'keeps the existing probability gate for %j',
    async (options) => {
      expect(
        await fixture(answers(options)).native.judgePermission(model, permission, [])
      ).toMatchObject({ decision: 'ask' });
    }
  );
  it('requires a prior user rejection before rejecting', async () => {
    const { native } = fixture(answers({ choice: 'reject' }));
    expect(await native.judgePermission(model, permission, [])).toMatchObject({ decision: 'ask' });
    expect(
      await native.judgePermission(model, permission, [
        { type: 'bash', title: 'cargo build', response: 'reject' },
      ])
    ).toMatchObject({ decision: 'reject' });
  });
  it.each(
    [
      [],
      [answers()[0], answers()[0], answers()[2]],
      [answers()[0], { name: 'destructive', type: 'error', reason: 'refusal' }, answers()[2]],
      answers({ probability: NaN }),
      answers({ confidence: Infinity }),
      answers({ manipulation: -1 }),
    ].map((value) => ({ value }))
  )('rejects incomplete or invalid answers %j', async ({ value }) => {
    await expect(fixture(value).native.judgePermission(model, permission, [])).rejects.toThrow(
      'Invalid native'
    );
  });
  it('does no native discovery on v1 and does not auto-select a model', async () => {
    const { server, request } = fixture();
    const v1 = new NativeDecisions({ ...server, apiVersion: 1 }, () => 'typesafe-ai/jev-latest');
    expect(v1.model).toBeNull();
    expect((await v1.status()).supported).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await expect(v1.judgePermission(model, permission, [])).rejects.toThrow('V2');
    expect(request).not.toHaveBeenCalled();
    expect(new NativeDecisions(server, () => '').model).toBeNull();
  });
  it('uses the selected native reviewer, caches only its verdict, and keeps external paths local-only', async () => {
    const { native, request, server } = fixture();
    const judge = new AutoApproveJudge(
      server,
      new HiddenSessionManager(),
      undefined,
      undefined,
      undefined,
      undefined,
      native
    );
    expect(await judge.resolveModel(undefined)).toEqual(model);
    expect(await judge.judge({ permission })).toMatchObject({
      decision: 'allow',
      reviewerModel: model,
    });
    expect(await judge.judge({ permission })).toMatchObject({
      decision: 'allow',
      reviewerModel: model,
    });
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    const before = request.mock.calls.length;
    expect(
      await judge.judge({
        permission: { ...permission, type: 'external_directory', pattern: '/outside' },
      })
    ).toMatchObject({ decision: 'ask' });
    expect(request).toHaveBeenCalledTimes(before);
  });
  it('reports missing endpoint support without attempting generation', async () => {
    const request = vi.fn<OpenCodeServer['request']>(async () => ({ paths: {} }));
    const native = new NativeDecisions({ request, apiVersion: 2 }, () => 'typesafe-ai/jev-latest');
    expect(await native.status()).toMatchObject({ supported: false, model, models: [] });
    await expect(native.judgePermission(model, permission, [])).rejects.toThrow('unavailable');
    expect(
      request.mock.calls.every(([method, route]) => method === 'GET' && route === '/openapi.json')
    ).toBe(true);
  });
  it('keeps native ask verdicts terminal and falls back to opted-in Jev only on errors', async () => {
    const { native, server, request } = fixture(answers({ confidence: 0.5 }));
    const jev = {
      model: { providerID: 'typesafe', modelID: 'legacy' },
      isAutoApproveEnabled: async () => true,
      judgePermission: vi.fn(async () => ({ decision: 'allow' as const })),
    };
    const judge = new AutoApproveJudge(
      server,
      new HiddenSessionManager(),
      undefined,
      undefined,
      undefined,
      jev,
      native
    );
    expect(await judge.judge({ permission })).toMatchObject({
      decision: 'ask',
      reviewerModel: model,
    });
    expect(jev.judgePermission).not.toHaveBeenCalled();
    request.mockImplementationOnce(async () => {
      throw new Error('Native provider unavailable');
    });
    expect(await judge.judge({ permission })).toMatchObject({
      decision: 'allow',
      reviewerModel: jev.model,
    });
    expect(jev.judgePermission).toHaveBeenCalledOnce();
  });
  it('uses a chat model, not the native decision route, when native generation fails', async () => {
    const { native, request, server } = fixture([]);
    const judge = new AutoApproveJudge(
      server,
      new HiddenSessionManager(),
      undefined,
      () => 'chat/reviewer',
      undefined,
      undefined,
      native
    );
    expect(await judge.judge({ permission })).toMatchObject({
      decision: 'ask',
      reviewerModel: { providerID: 'chat', modelID: 'reviewer' },
    });
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/session/ses_judge/message',
      expect.objectContaining({ model: { providerID: 'chat', modelID: 'reviewer' } })
    );
  });
});
