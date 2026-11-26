import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Provider } from './opencode-types';
import {
  addPromptCacheSample,
  emptyPromptCacheHistogram,
  isPromptCacheHistogram,
  learnPromptCacheLifetime,
  promptCacheHistorySamples,
  promptCacheSample,
  withLearnedPromptCacheLifetime,
  parsePromptCacheTtl,
  promptCacheKeepAliveIntervalMs,
  promptCacheLifetimeFor,
  promptCacheUsedAt,
  resolvePromptCacheLifetime,
} from './prompt-cache-lifetime';
import type { UnknownRecord } from './type-utils';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type CatalogModel = Provider['models'][string];

function catalogModel(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, capabilities: {}, cost: { input: 0, output: 0 }, ...extra };
}

function catalogProvider(id: string, models: CatalogModel[], options?: UnknownRecord): Provider {
  return {
    id,
    name: id,
    source: 'api',
    options,
    models: Object.fromEntries(models.map((model) => [model.id, model])),
  };
}

function ttlOf(providerID: string, modelID: string, extra: { ttl?: string; npm?: string } = {}) {
  return resolvePromptCacheLifetime({ providerID, modelID, ...extra }).ttlMs;
}

describe('prompt cache lifetime', () => {
  it('parses OpenCode cache.ttl durations', () => {
    expect(parsePromptCacheTtl('5m')).toBe(5 * MINUTE);
    expect(parsePromptCacheTtl('1h')).toBe(HOUR);
    expect(parsePromptCacheTtl('90s')).toBe(90_000);
    expect(parsePromptCacheTtl('0m')).toBeUndefined();
    expect(parsePromptCacheTtl('in_memory')).toBeUndefined();
    expect(parsePromptCacheTtl(undefined)).toBeUndefined();
  });

  it('applies Claude defaults and the 1 h ttl on every host', () => {
    expect(ttlOf('anthropic', 'claude-sonnet-5-5')).toBe(5 * MINUTE);
    expect(ttlOf('anthropic', 'claude-opus-5-5', { ttl: '1h' })).toBe(HOUR);
    expect(ttlOf('openrouter', 'anthropic/claude-opus-5-5', { ttl: '1h' })).toBe(HOUR);
    expect(ttlOf('amazon-bedrock', 'us.anthropic.claude-sonnet-5-5-v1:0', { ttl: '1h' })).toBe(
      HOUR
    );
    // Older Bedrock releases cache for five minutes only, so OpenCode drops the 1 h ttl.
    expect(ttlOf('amazon-bedrock', 'anthropic.claude-sonnet-4-20250514-v1:0', { ttl: '1h' })).toBe(
      5 * MINUTE
    );
  });

  it('recognizes Claude Code model aliases, whose steps hold several requests', () => {
    // Claude Agent prices models only for API billing; subscriptions get Claude Code's 1 h cache.
    for (const lifetime of [
      resolvePromptCacheLifetime({ providerID: 'claude-agent', modelID: 'sonnet', ttl: '5m' }),
      resolvePromptCacheLifetime({
        providerID: 'my-claude',
        modelID: 'fable',
        npm: 'aisdk:@opencode/claude-agent',
        priced: false,
      }),
    ])
      expect(lifetime).toMatchObject({ ttlMs: HOUR, multiRequestSteps: true });
    expect(
      resolvePromptCacheLifetime({ providerID: 'claude-agent', modelID: 'opus', priced: true })
    ).toMatchObject({ ttlMs: 5 * MINUTE, multiRequestSteps: true });
    expect(
      resolvePromptCacheLifetime({ providerID: 'anthropic', modelID: 'claude-opus-5-5' })
    ).not.toHaveProperty('multiRequestSteps');
  });

  it('does not treat Anthropic-compatible APIs of other models as Claude', () => {
    const lifetime = resolvePromptCacheLifetime({
      providerID: 'my-gateway',
      modelID: 'glm-5.3',
      npm: '@ai-sdk/anthropic',
    });
    expect(lifetime).toMatchObject({ ttlMs: 5 * MINUTE, source: 'fallback' });
  });

  it('follows other popular providers', () => {
    const lifetime = (providerID: string, modelID: string, ttl?: string) => {
      const { ttlMs, likelyMs } = resolvePromptCacheLifetime({ providerID, modelID, ttl });
      return [ttlMs / MINUTE, (likelyMs ?? ttlMs) / MINUTE];
    };
    expect(lifetime('google', 'gemini-4-argon')).toEqual([5, 15]);
    expect(lifetime('google-vertex', 'gemini-3.8-flash')).toEqual([5, 15]);
    expect(lifetime('openrouter', 'google/gemini-4-argon')).toEqual([5, 15]);
    expect(lifetime('deepseek', 'deepseek-v4-flash')).toEqual([60, 360]);
    expect(lifetime('xai', 'grok-4.6')).toEqual([5, 30]);
    expect(lifetime('openrouter', 'x-ai/grok-4.6')).toEqual([5, 30]);
    expect(lifetime('zai-coding-plan', 'glm-5.3')).toEqual([5, 60]);
    expect(lifetime('kimi-for-coding', 'k3')).toEqual([5, 5]);
    expect(lifetime('moonshotai', 'kimi-k3.1-pro', '1h')).toEqual([60, 60]);
    expect(lifetime('alibaba', 'qwen3.8-max', '1h')).toEqual([5, 5]);
    expect(lifetime('alibaba', 'qwen4-max', '1h')).toEqual([60, 60]);
    expect(lifetime('groq', 'openai/gpt-oss-120b')).toEqual([5, 120]);
    expect(lifetime('fireworks-ai', 'accounts/fireworks/models/glm-5')).toEqual([5, 60]);
    expect(lifetime('meta', 'muse-spark-1.3')).toEqual([5, 15]);
    expect(lifetime('meta', 'muse-spark-1.3', '24h')).toEqual([5, 60]);
    expect(lifetime('amazon-bedrock', 'amazon.nova-pro-v1:0')).toEqual([5, 5]);
    expect(lifetime('amazon-bedrock', 'openai.gpt-6.1-sol', '12h')).toEqual([30, 180]);
    expect(lifetime('amazon-bedrock', 'openai.gpt-5.4')).toEqual([5, 10]);
    expect(lifetime('kimi-code-plan-global', 'kimi-k3')).toEqual([5, 5]);
    expect(lifetime('alibaba-token-plan-cn', 'qwen4-max', '1h')).toEqual([60, 60]);
    expect(lifetime('mistral', 'mistral-large-latest')).toEqual([3, 5]);
    // Open-weight models on OpenRouter can be served by any host, with its own cache.
    expect(lifetime('openrouter', 'deepseek/deepseek-v4')).toEqual([5, 15]);
    expect(lifetime('github-copilot', 'mai-code-1.1-flash')).toEqual([5, 15]);
  });

  it('follows OpenAI retention by model generation', () => {
    // GPT-5.6 and later: a 30 min minimum by default that often lasts about 3 h, 12 h when configured.
    expect(
      resolvePromptCacheLifetime({ providerID: 'openai', modelID: 'gpt-6.2-sol' })
    ).toMatchObject({ ttlMs: 30 * MINUTE, likelyMs: 3 * HOUR });
    expect(ttlOf('openai', 'gpt-5.6')).toBe(30 * MINUTE);
    expect(ttlOf('openai', 'gpt-6-luna', { ttl: '12h' })).toBe(12 * HOUR);
    expect(ttlOf('openrouter', 'openai/gpt-6.1-terra')).toBe(30 * MINUTE);
    // 24-hour retention usually lasts about 30 min.
    expect(ttlOf('openai', 'gpt-5.5')).toBe(30 * MINUTE);
    expect(ttlOf('opencode', 'gpt-5.1-codex')).toBe(30 * MINUTE);
    expect(ttlOf('openai', 'gpt-4.1-2025-04-14')).toBe(30 * MINUTE);
    // In-memory retention otherwise.
    expect(ttlOf('openai', 'gpt-4.1-mini')).toBe(5 * MINUTE);
    expect(ttlOf('openai', 'gpt-4o')).toBe(5 * MINUTE);
    expect(ttlOf('openai', 'o4-mini')).toBe(5 * MINUTE);
  });

  it('leaves GPT-named models on other hosts to the generic estimate', () => {
    expect(
      resolvePromptCacheLifetime({ providerID: 'groq', modelID: 'openai/gpt-oss-120b' })
    ).toMatchObject({ ttlMs: 5 * MINUTE, likelyMs: 2 * HOUR });
    expect(
      resolvePromptCacheLifetime({ providerID: 'github-copilot', modelID: 'gpt-6.2-sol' }).source
    ).toBe('fallback');
    expect(ttlOf('my-gateway', 'gpt-6.2-sol', { npm: '@ai-sdk/openai' })).toBe(30 * MINUTE);
    expect(ttlOf('my-gateway', 'gpt-6.2-sol', { npm: 'aisdk:@ai-sdk/openai' })).toBe(30 * MINUTE);
  });

  it('uses a configured ttl for other providers', () => {
    expect(
      resolvePromptCacheLifetime({ providerID: 'my-gateway', modelID: 'deepseek-v4', ttl: '1h' })
    ).toMatchObject({ ttlMs: HOUR, source: 'configured' });
  });

  it('reads cache.ttl from model settings over provider settings', () => {
    const agent = catalogProvider('claude-agent', [
      catalogModel('opus'),
      catalogModel('sonnet', { cost: { input: 3, output: 15 } }),
    ]);
    expect(
      promptCacheLifetimeFor([agent], { providerID: 'claude-agent', modelID: 'opus' }).ttlMs
    ).toBe(HOUR);
    expect(
      promptCacheLifetimeFor([agent], { providerID: 'claude-agent', modelID: 'sonnet' }).ttlMs
    ).toBe(5 * MINUTE);
    const providers = [
      catalogProvider(
        'anthropic',
        [
          catalogModel('sonnet', {
            api: { id: 'claude-sonnet-5-5', npm: '@ai-sdk/anthropic', url: '' },
          }),
          catalogModel('opus', {
            options: { cache: { ttl: '5m' } },
            api: { id: 'claude-opus-5-5', npm: '@ai-sdk/anthropic', url: '' },
          }),
        ],
        { cache: { ttl: '1h' } }
      ),
    ];
    expect(
      promptCacheLifetimeFor(providers, { providerID: 'anthropic', modelID: 'sonnet' }).ttlMs
    ).toBe(HOUR);
    expect(
      promptCacheLifetimeFor(providers, { providerID: 'anthropic', modelID: 'opus' }).ttlMs
    ).toBe(5 * MINUTE);
    expect(
      promptCacheLifetimeFor(undefined, { providerID: 'anthropic', modelID: 'claude-x-1' }).ttlMs
    ).toBe(5 * MINUTE);
  });

  it('counts from the request when a response is one request, else from its end', () => {
    const time = { created: 1_000, completed: 9_000 };
    const claude = resolvePromptCacheLifetime({ providerID: 'anthropic', modelID: 'claude-x-1' });
    const agent = resolvePromptCacheLifetime({ providerID: 'claude-agent', modelID: 'opus' });
    expect(claude).not.toHaveProperty('likelyMs');
    expect(promptCacheUsedAt(time, 0, claude)).toBe(1_000);
    expect(promptCacheUsedAt(time, 1, claude)).toBe(1_000);
    expect(promptCacheUsedAt(time, 2, claude)).toBe(9_000);
    expect(promptCacheUsedAt(time, 0, agent)).toBe(9_000);
  });

  describe('learning from observed gaps', () => {
    function learn(samples: Array<[gapMinutes: number, hits: number, misses: number]>) {
      let histogram = emptyPromptCacheHistogram();
      for (const [minutes, hits, misses] of samples) {
        for (let i = 0; i < hits; i += 1)
          histogram = addPromptCacheSample(histogram, { gapMs: minutes * MINUTE, hit: true });
        for (let i = 0; i < misses; i += 1)
          histogram = addPromptCacheSample(histogram, { gapMs: minutes * MINUTE, hit: false });
      }
      return learnPromptCacheLifetime(histogram);
    }

    it('finds the end of a hard lifetime, skipping sparse gaps', () => {
      // Claude Code on a subscription: alive through 1 h, gone after.
      expect(
        learn([
          [7, 34, 3],
          [15, 16, 5],
          [25, 6, 1],
          [40, 6, 2],
          [50, 5, 1],
          [70, 0, 1],
          [100, 0, 2],
          [200, 0, 3],
        ])
      ).toEqual({ ms: HOUR, bounded: true });
      // API billing: gone after 5 min.
      expect(learn([[7, 0, 4]])).toEqual({ ms: 5 * MINUTE, bounded: true });
    });

    it('finds where a gradual decline drops below half', () => {
      // OpenAI GPT-6: 94% to 70% hits up to 3 h, 44% after.
      expect(
        learn([
          [20, 30, 2],
          [50, 13, 2],
          [75, 8, 2],
          [100, 7, 2],
          [150, 7, 3],
          [240, 4, 5],
          [500, 0, 10],
        ])
      ).toEqual({ ms: 3 * HOUR, bounded: true });
    });

    it('treats survived gaps without misses as a floor', () => {
      expect(learn([[7, 5, 0]])).toEqual({ ms: 10 * MINUTE, bounded: false });
      expect(learn([[7, 2, 0]])).toBeUndefined();
    });

    it('lets recent samples outweigh old ones', () => {
      // 40 old hits, then the account starts missing.
      expect(
        learn([
          [15, 40, 0],
          [15, 0, 30],
        ])
      ).toEqual({ ms: 10 * MINUTE, bounded: true });
    });

    it('applies a floor only when it lengthens the estimate, and a bound always', () => {
      const claude = resolvePromptCacheLifetime({ providerID: 'claude-agent', modelID: 'opus' });
      expect(withLearnedPromptCacheLifetime(claude, { ms: 10 * MINUTE, bounded: false })).toBe(
        claude
      );
      expect(
        withLearnedPromptCacheLifetime(claude, { ms: 90 * MINUTE, bounded: false })
      ).toMatchObject({ ttlMs: HOUR, likelyMs: 90 * MINUTE });
      // Extra usage or API billing: keep-alives follow the shorter, observed lifetime.
      expect(
        withLearnedPromptCacheLifetime(claude, { ms: 5 * MINUTE, bounded: true })
      ).toMatchObject({ ttlMs: 5 * MINUTE, likelyMs: 5 * MINUTE });
      const gpt = resolvePromptCacheLifetime({ providerID: 'openai', modelID: 'gpt-6.2-sol' });
      expect(withLearnedPromptCacheLifetime(gpt, { ms: 6 * HOUR, bounded: true })).toMatchObject({
        ttlMs: 30 * MINUTE,
        likelyMs: 6 * HOUR,
      });
    });

    it('prefers the model, then the provider', () => {
      const learned = {
        'openai/gpt-6.2-sol': { ms: 2 * HOUR, bounded: true },
        'openai/*': { ms: HOUR, bounded: true },
      };
      const model = (modelID: string) =>
        promptCacheLifetimeFor(undefined, { providerID: 'openai', modelID }, learned).likelyMs;
      expect(model('gpt-6.2-sol')).toBe(2 * HOUR);
      expect(model('gpt-6.1-sol')).toBe(HOUR);
    });

    it('samples only idle gaps of large prompts', () => {
      const tokens = (read: number, input = 100) => ({ input, cache: { read, write: 0 } });
      expect(promptCacheSample(0, 4 * MINUTE, tokens(50_000))).toBeNull();
      expect(promptCacheSample(0, 6 * MINUTE, tokens(1_000))).toBeNull();
      expect(promptCacheSample(0, 6 * MINUTE, tokens(50_000))).toEqual({
        gapMs: 6 * MINUTE,
        hit: true,
      });
      expect(promptCacheSample(0, 6 * MINUTE, tokens(0, 50_000))).toEqual({
        gapMs: 6 * MINUTE,
        hit: false,
      });
    });

    it('extracts idle-gap samples from a session history', () => {
      const assistant = (
        created: number,
        read: number,
        extra: Partial<AssistantMessage> = {},
        steps = 1
      ) => ({
        info: {
          id: `msg_${created}`,
          sessionID: 'ses_1',
          role: 'assistant' as const,
          time: { created: created * MINUTE, completed: created * MINUTE + 10_000 },
          parentID: 'msg_user',
          modelID: 'claude-opus-5-5',
          providerID: 'anthropic',
          mode: 'build',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: {
            input: read ? 100 : 50_000,
            output: 10,
            reasoning: 0,
            cache: { read, write: 0 },
          },
          ...extra,
        },
        parts: Array.from({ length: steps }, () => ({ type: 'step-finish' })),
      });
      const samples = promptCacheHistorySamples(
        [
          assistant(0, 50_000),
          assistant(2, 50_000), // too soon after the last request
          assistant(12, 50_000), // a 10 min idle hit
          assistant(20, 0, { modelID: 'claude-sonnet-5-5' }), // another model's cache
          assistant(30, 0, { summary: true }), // compaction
          assistant(40, 0), // follows the compaction
          assistant(50, 0, {}, 2), // several steps
          assistant(60, 0), // a 10 min idle miss
        ],
        undefined
      );
      expect(samples).toEqual([
        {
          providerID: 'anthropic',
          modelID: 'claude-opus-5-5',
          at: 12 * MINUTE,
          gapMs: 10 * MINUTE,
          hit: true,
        },
        {
          providerID: 'anthropic',
          modelID: 'claude-opus-5-5',
          // Counted from the end of the multi-step response.
          at: 60 * MINUTE,
          gapMs: 10 * MINUTE - 10_000,
          hit: false,
        },
      ]);
    });

    it('validates persisted histograms', () => {
      expect(isPromptCacheHistogram(emptyPromptCacheHistogram())).toBe(true);
      expect(isPromptCacheHistogram([[1, 2]])).toBe(false);
      expect(isPromptCacheHistogram(emptyPromptCacheHistogram().map(() => [-1, 0]))).toBe(false);
    });
  });

  it('pings a minute early for short lifetimes and 10% early for long ones', () => {
    expect(promptCacheKeepAliveIntervalMs(5 * MINUTE)).toBe(4 * MINUTE);
    expect(promptCacheKeepAliveIntervalMs(30 * MINUTE)).toBe(27 * MINUTE);
    expect(promptCacheKeepAliveIntervalMs(HOUR)).toBe(54 * MINUTE);
    expect(promptCacheKeepAliveIntervalMs(90_000)).toBe(45_000);
  });
});
