import type { Message, Provider } from './opencode-types';
import type { PromptCacheHistorySample } from './protocol';
import { asRecord, isString } from './type-utils';

/**
 * How long a provider keeps an idle prompt cache entry, from each provider's documented behavior.
 * Claude and OpenAI refresh an entry whenever a request reads it, and both count its lifetime from
 * when that request was sent, not from when its response finished.
 */
export type PromptCacheLifetime = {
  /**
   * How long the entry is sure to live after the request that last read or wrote it. Keep-alives
   * follow this, since one that arrives late pays to rebuild the cache.
   */
  ttlMs: number;
  /**
   * How long the entry usually lives when the provider often keeps it past `ttlMs`. Expiry
   * warnings wait for this, so a cache that is probably still warm is not reported as gone.
   */
  likelyMs?: number;
  /** `configured`: the model's `cache.ttl`; `provider`: the provider's documented default. */
  source: 'configured' | 'provider' | 'fallback';
  /** One sentence for tooltips explaining where `ttlMs` comes from. */
  description: string;
  /**
   * One OpenCode step can hold several provider requests, as when Claude Code runs its own loop,
   * so the step's dispatch time is too early. Only the end of its response bounds the last request.
   */
  multiRequestSteps?: true;
};

/** Claude Code through OpenCode's Claude Agent provider, which lists models by alias such as `sonnet`. */
const CLAUDE_AGENT_PROVIDER = 'claude-agent';
const CLAUDE_AGENT_PACKAGE = '@opencode/claude-agent';

export type PromptCacheModel = { providerID: string; modelID: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The most common default when neither the provider nor the model says otherwise. */
export const FALLBACK_PROMPT_CACHE_TTL_MS = 5 * MINUTE;

const TTL_UNITS = { ms: 1, s: 1_000, m: MINUTE, h: HOUR, d: 24 * HOUR } as const;

/** Parses OpenCode's `cache.ttl` duration format, such as `"5m"`, `"1h"` or `"24h"`. */
export function parsePromptCacheTtl(value: string | undefined): number | undefined {
  const match = value === undefined ? null : /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) return undefined;
  // SAFETY: The pattern only captures TTL_UNITS keys.
  const ms = Number(match[1]) * TTL_UNITS[match[2] as keyof typeof TTL_UNITS];
  return ms > 0 ? ms : undefined;
}

function formatTtl(ms: number) {
  return ms >= HOUR && ms % HOUR === 0 ? `${ms / HOUR} h` : `${Math.round(ms / MINUTE)} min`;
}

// Bedrock releases that cache for five minutes only; OpenCode drops a "1h" ttl for them.
const BEDROCK_CLAUDE_5M = [
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'anthropic.claude-3-5-haiku-20241022-v1:0',
  'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'anthropic.claude-sonnet-4-20250514-v1:0',
  'anthropic.claude-opus-4-20250514-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
];

// Hosts that serve OpenAI models with OpenAI's own prompt cache. Other hosts of GPT-named models,
// such as GitHub Copilot, manage caching themselves.
const OPENAI_PROVIDERS = new Set(['openai', 'azure', 'opencode', 'openrouter', 'amazon-bedrock']);
const OPENAI_PACKAGES = new Set(['@ai-sdk/openai', '@ai-sdk/azure']);
// Models before GPT-5.6 that support `prompt_cache_retention: "24h"`. GPT-5.5 supports only that.
const OPENAI_EXTENDED_RETENTION = new Set([
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.2',
  'gpt-5.1-codex-max',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-chat-latest',
  'gpt-5',
  'gpt-5-codex',
  'gpt-4.1',
]);

function claudeLifetime(modelID: string, ttlMs: number | undefined): PromptCacheLifetime {
  if (
    ttlMs !== undefined &&
    !(ttlMs > 5 * MINUTE && BEDROCK_CLAUDE_5M.some((id) => modelID.includes(id)))
  )
    return {
      ttlMs,
      source: 'configured',
      description: `Claude keeps the cache ${formatTtl(ttlMs)} (cache.ttl) from the start of each request that reads it.`,
    };
  return {
    ttlMs: 5 * MINUTE,
    source: 'provider',
    description: 'Claude keeps the cache 5 min from the start of each request that reads it.',
  };
}

function openAILifetime(
  baseID: string,
  ttl: string | undefined,
  host: string
): PromptCacheLifetime {
  const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(baseID);
  const major = Number(version?.[1] ?? 0);
  const minor = Number(version?.[2] ?? 0);
  // Bedrock documents only the GPT-5.6+ minimum, and accepts no lifetime besides it.
  const bedrock = host === 'amazon-bedrock';
  if (major > 5 || (major === 5 && minor >= 6)) {
    // `prompt_cache_options.ttl` takes "30m" (the default) or "12h"; both are minimum lifetimes.
    if (ttl === '12h' && !bedrock)
      return {
        ttlMs: 12 * HOUR,
        source: 'configured',
        description:
          'OpenAI keeps the cache at least 12 h (cache.ttl) after each request that reads it.',
      };
    // Entries often live much longer than the minimum: in observed GPT-6 sessions, a request after
    // 1 to 3 h idle still read the cache about three times in four, after 3 to 6 h less than half
    // the time, and after 6 h almost never.
    return {
      ttlMs: 30 * MINUTE,
      likelyMs: 3 * HOUR,
      source: 'provider',
      description:
        'OpenAI keeps the cache at least 30 min after each request that reads it, and often up to about 3 h.',
    };
  }
  const undated = baseID.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (OPENAI_EXTENDED_RETENTION.has(undated) && !bedrock)
    // GPT-5.5 always uses 24-hour retention. Earlier models default to it unless the organization
    // uses Zero Data Retention, which keeps the in-memory default instead.
    return {
      ttlMs: 30 * MINUTE,
      source: ttl === '24h' ? 'configured' : 'provider',
      description: undated.startsWith('gpt-5.5')
        ? "OpenAI's 24-hour retention usually keeps the cache about 30 min after each request, sometimes up to 24 h."
        : "OpenAI's 24-hour retention usually keeps the cache about 30 min after each request, sometimes up to 24 h. Zero Data Retention organizations get about 5 to 10 min.",
    };
  return {
    ttlMs: 5 * MINUTE,
    likelyMs: 10 * MINUTE,
    source: 'provider',
    description:
      "OpenAI's in-memory cache usually lasts 5 to 10 min after each request, at most 1 h.",
  };
}

/**
 * OpenRouter passes a proprietary vendor's requests to that vendor's own cache, under its usual
 * rules. Open-weight models can be served by any host there, each with its own cache.
 */
const OPENROUTER_VENDORS = new Map([
  ['google', 'google'],
  ['x-ai', 'xai'],
]);

function hostFor(providerID: string, id: string) {
  if (providerID !== 'openrouter') return providerID;
  return OPENROUTER_VENDORS.get(id.slice(0, id.indexOf('/'))) ?? providerID;
}

/**
 * Documented or measured lifetimes for other popular providers. Most cache automatically without
 * promising a lifetime, so `ttlMs` stays at what can be counted on and `likelyMs` follows
 * what the provider describes or independent measurements found.
 */
function otherProviderLifetime(
  host: string,
  id: string,
  ttl: string | undefined
): PromptCacheLifetime | undefined {
  // Gemini's implicit cache has no fixed lifetime. Google Cloud keeps prefixes at most 24 h and
  // its Argon guide gives a 15 to 20 min window; measurements found 5 to 15 min under load.
  if (/^(google|google-vertex)$/.test(host) && id.includes('gemini'))
    return {
      ttlMs: 5 * MINUTE,
      likelyMs: 15 * MINUTE,
      source: 'provider',
      description:
        "Gemini's implicit cache has no fixed lifetime; it usually lasts 5 to 15 min after each request, at most 24 h.",
    };
  // A disk cache, cleared "usually within a few hours to a few days" once unused.
  if (host === 'deepseek')
    return {
      ttlMs: HOUR,
      likelyMs: 6 * HOUR,
      source: 'provider',
      description:
        "DeepSeek's disk cache is usually cleared a few hours to a few days after its last use.",
    };
  // No published lifetime: entries "can be evicted at any time". Measured at about 30 min.
  if (host === 'xai')
    return {
      ttlMs: 5 * MINUTE,
      likelyMs: 30 * MINUTE,
      source: 'provider',
      description:
        'xAI publishes no cache lifetime and may evict entries at any time; it usually lasts about 30 min.',
    };
  // No published lifetime. Measured on the coding plan: every request still hit after 60 min idle.
  if (/^(zai|zai-coding-plan|zhipuai|zhipuai-coding-plan)$/.test(host))
    return {
      ttlMs: 5 * MINUTE,
      likelyMs: HOUR,
      source: 'provider',
      description:
        'Z.ai publishes no cache lifetime; it usually lasts at least 1 h after each request.',
    };
  // 5 min, renewed by each hit; `prompt_cache_options.ttl` (OpenCode's cache.ttl) selects 1 h.
  if (
    /^(moonshotai|moonshotai-cn|kimi-for-coding|kimi-code-plan-cn|kimi-code-plan-global)$/.test(
      host
    )
  )
    return ttl === '1h'
      ? {
          ttlMs: HOUR,
          source: 'configured',
          description: 'Kimi keeps the cache 1 h (cache.ttl) after each request that reads it.',
        }
      : {
          ttlMs: 5 * MINUTE,
          source: 'provider',
          description:
            'Kimi keeps the cache 5 min after each request that reads it, or 1 h with cache.ttl "1h".',
        };
  // OpenCode marks Model Studio requests for its explicit cache: 5 min, renewed by each hit.
  // Qwen4 also accepts a 1 h lifetime.
  if (/^alibaba(-coding-plan|-token-plan)?(-cn)?$/.test(host))
    return ttl === '1h' && id.includes('qwen4')
      ? {
          ttlMs: HOUR,
          source: 'configured',
          description: 'Qwen keeps the cache 1 h (cache.ttl) after each request that reads it.',
        }
      : {
          ttlMs: 5 * MINUTE,
          source: 'provider',
          description: 'Model Studio keeps the cache 5 min after each request that reads it.',
        };
  // "All cached data automatically expires after 2 hours without use"; hits are best effort.
  if (host === 'groq')
    return {
      ttlMs: 5 * MINUTE,
      likelyMs: 2 * HOUR,
      source: 'provider',
      description: "Groq's cache expires 2 h after its last use, and hits are best effort.",
    };
  // "Usually stay in the cache for at least several minutes", up to several hours under low load.
  if (host === 'fireworks-ai')
    return {
      ttlMs: 5 * MINUTE,
      likelyMs: HOUR,
      source: 'provider',
      description:
        'Fireworks usually keeps the cache several minutes, and up to several hours under low load.',
    };
  // In memory by default; `prompt_cache_retention: "24h"` is only a hint the server may ignore.
  if (host === 'meta')
    return {
      ttlMs: 5 * MINUTE,
      likelyMs: ttl === '24h' ? HOUR : 15 * MINUTE,
      source: ttl === '24h' ? 'configured' : 'provider',
      description:
        'Meta keeps the cache in memory until load or inactivity evicts it; the 24 h retention setting is only a hint.',
    };
  // Nova caches for 5 min only and rejects a longer ttl.
  if (host === 'amazon-bedrock' && id.includes('amazon.nova'))
    return {
      ttlMs: 5 * MINUTE,
      source: 'provider',
      description: 'Nova on Bedrock keeps the cache 5 min after each request that reads it.',
    };
  // Undocumented: entries reportedly drop after a few minutes of quiet.
  if (host === 'mistral')
    return {
      ttlMs: 3 * MINUTE,
      likelyMs: 5 * MINUTE,
      source: 'provider',
      description: 'Mistral publishes no cache lifetime; it reportedly lasts only a few minutes.',
    };
  return undefined;
}

/**
 * The expected cache lifetime of a model. `ttl` is the effective `cache.ttl` setting, which OpenCode
 * sends to the provider as given; `npm`, `apiModelID` and `priced` (the catalog lists an input
 * price) come from the provider catalog when known.
 */
export function resolvePromptCacheLifetime(
  model: PromptCacheModel & { ttl?: string; npm?: string; apiModelID?: string; priced?: boolean }
): PromptCacheLifetime {
  const id = (model.apiModelID || model.modelID).toLowerCase();
  const ttlMs = parsePromptCacheTtl(model.ttl);
  // OpenCode prefixes AI SDK packages it loads itself, such as `aisdk:@ai-sdk/openai`.
  const npm = model.npm?.replace(/^aisdk:/, '') ?? '';
  // Claude Code sets its own cache markers and ignores OpenCode's cache.ttl. Claude subscriptions
  // get a 1 h cache unless they run on extra usage; API billing keeps Claude's 5 min default.
  // Claude Agent prices models only for API billing, so an unpriced model means a subscription.
  if (model.providerID === CLAUDE_AGENT_PROVIDER || npm === CLAUDE_AGENT_PACKAGE)
    return model.priced
      ? {
          ttlMs: 5 * MINUTE,
          source: 'provider',
          description: 'Claude Code on API billing keeps the cache 5 min after its last request.',
          multiRequestSteps: true,
        }
      : {
          ttlMs: HOUR,
          source: 'provider',
          description:
            'Claude Code on a Claude subscription keeps the cache 1 h after its last request, 5 min while on extra usage.',
          multiRequestSteps: true,
        };
  // Model IDs identify Claude on every host: Anthropic, Bedrock, Vertex, OpenRouter and gateways.
  // Packages do not, since other providers expose Anthropic-compatible APIs for their own models.
  if (/(?:^|[/.:])claude-/.test(id)) return claudeLifetime(id, ttlMs);
  // Bedrock names OpenAI models `openai.gpt-…`, with an optional regional profile prefix.
  const baseID = id.slice(id.lastIndexOf('/') + 1).replace(/^(?:[a-z]+\.)?openai\./, '');
  if (
    (OPENAI_PROVIDERS.has(model.providerID) || OPENAI_PACKAGES.has(npm)) &&
    /^(gpt-\d|o\d)/.test(baseID) &&
    !baseID.startsWith('gpt-oss')
  )
    return openAILifetime(baseID, model.ttl, model.providerID);
  const other = otherProviderLifetime(hostFor(model.providerID, id), id, model.ttl);
  if (other) return other;
  if (ttlMs !== undefined)
    return {
      ttlMs,
      source: 'configured',
      description: `The model's cache.ttl keeps the cache ${formatTtl(ttlMs)} after each request.`,
    };
  // Most measured caches outlive 5 min, so the estimate only calls one likely expired after 15.
  return {
    ttlMs: FALLBACK_PROMPT_CACHE_TTL_MS,
    likelyMs: 15 * MINUTE,
    source: 'fallback',
    description:
      'This provider publishes no cache lifetime; most keep the cache 5 to 30 min after each request.',
  };
}

/**
 * When a completed response last used the cache. Providers count the lifetime from when a request
 * is sent, so a long response uses up part of it. A V2 step or a single-step V1 response is one
 * request, sent at `created`. A V1 response with several steps, or a step that holds several
 * requests such as Claude Code's own loop, sent its last request at an unknown time; its
 * completion is the closest known bound.
 */
export function promptCacheUsedAt(
  time: { created: number; completed: number },
  steps: number,
  lifetime: PromptCacheLifetime
): number {
  return steps > 1 || lifetime.multiRequestSteps ? time.completed : time.created;
}

/**
 * How long caches have lasted: `ms` is the longest idle gap they usually survived. `bounded` means
 * longer gaps mostly missed, so `ms` is also when they usually expire; otherwise it is only a floor.
 */
export type LearnedPromptCacheLifetime = { ms: number; bounded: boolean };

/** Learned lifetimes by `promptCacheModelKey`, with `providerID/*` for each provider's models together. */
export type LearnedPromptCacheLifetimes = Readonly<Record<string, LearnedPromptCacheLifetime>>;

export function promptCacheModelKey(model: PromptCacheModel): string {
  return `${model.providerID}/${model.modelID}`;
}

export function promptCacheProviderKey(providerID: string): string {
  return `${providerID}/*`;
}

/**
 * Applies how long this user's caches have actually lasted. Accounts differ, by plan, data
 * retention or extra usage, so evidence replaces the usual-lifetime guess. It only shortens the
 * guaranteed lifetime, so the estimate never promises a cache that has already expired.
 */
export function withLearnedPromptCacheLifetime(
  lifetime: PromptCacheLifetime,
  learned: LearnedPromptCacheLifetime | undefined
): PromptCacheLifetime {
  if (!learned) return lifetime;
  const likelyMs = lifetime.likelyMs ?? lifetime.ttlMs;
  if (!learned.bounded) {
    // Survived gaps raise the estimate but say nothing about when caches expire.
    if (learned.ms <= likelyMs) return lifetime;
    return {
      ...lifetime,
      likelyMs: learned.ms,
      description: `${lifetime.description} In your recent sessions it lasted at least ${formatTtl(learned.ms)}.`,
    };
  }
  return {
    ...lifetime,
    ttlMs: Math.min(lifetime.ttlMs, learned.ms),
    likelyMs: learned.ms,
    description: `${lifetime.description} In your recent sessions it usually lasted about ${formatTtl(learned.ms)}.`,
  };
}

/**
 * Resolves a model's lifetime from the provider catalog. Model settings override provider
 * settings, as in OpenCode's runtime merge.
 */
export function promptCacheLifetimeFor(
  providers: readonly Provider[] | undefined,
  model: PromptCacheModel,
  learned?: LearnedPromptCacheLifetimes
): PromptCacheLifetime {
  const provider = providers?.find((item) => item.id === model.providerID);
  const info = provider?.models[model.modelID];
  const ttl =
    asRecord(asRecord(info?.options)?.cache)?.ttl ??
    asRecord(asRecord(provider?.options)?.cache)?.ttl;
  const lifetime = resolvePromptCacheLifetime({
    ...model,
    ttl: isString(ttl) ? ttl : undefined,
    npm: info?.api?.npm,
    apiModelID: info?.api?.id,
    priced: info ? info.cost.input > 0 : undefined,
  });
  return withLearnedPromptCacheLifetime(
    lifetime,
    learned?.[promptCacheModelKey(model)] ?? learned?.[promptCacheProviderKey(model.providerID)]
  );
}

/** Whether a request after an idle gap read the cache. Shorter gaps say nothing about expiry. */
export type PromptCacheSample = { gapMs: number; hit: boolean };

const SAMPLE_MIN_GAP_MS = 5 * MINUTE;
// Below this, a prompt may be under the provider's minimum cacheable size and never cache at all.
const SAMPLE_MIN_TOKENS = 8_192;

/**
 * The evidence from a request sent at `sentAt` after the cache was last used at `previousUsedAt`.
 * A request that read most of its input from the cache found it alive.
 */
export function promptCacheSample(
  previousUsedAt: number,
  sentAt: number,
  tokens: { input: number; cache: { read: number; write: number } }
): PromptCacheSample | null {
  const gapMs = sentAt - previousUsedAt;
  const total = tokens.input + tokens.cache.read + tokens.cache.write;
  if (gapMs < SAMPLE_MIN_GAP_MS || total < SAMPLE_MIN_TOKENS) return null;
  return { gapMs, hit: tokens.cache.read * 2 > total };
}

const MAX_HISTORY_SAMPLES = 500;

/**
 * Idle-gap samples from a session's loaded messages, oldest first. A sample needs the same model
 * on both sides of the gap, since another model has its own cache. Errors and compaction
 * summaries break the chain: the cache may not have been used, or the prompt changed. A response
 * with several steps is not a sample itself, since its token counts cover later requests too.
 */
export function promptCacheHistorySamples(
  entries: ReadonlyArray<{ info: Message; parts: ReadonlyArray<{ type: string }> }>,
  providers: readonly Provider[] | undefined
): PromptCacheHistorySample[] {
  const samples: PromptCacheHistorySample[] = [];
  let previous: (PromptCacheModel & { at: number }) | null = null;
  for (const { info, parts } of entries) {
    if (info.role !== 'assistant') continue;
    const completed = info.time.completed;
    if (!completed || info.error || info.summary || !info.providerID || !info.modelID) {
      previous = null;
      continue;
    }
    const model = { providerID: info.providerID, modelID: info.modelID };
    let steps = 0;
    for (const part of parts) if (part.type === 'step-finish') steps += 1;
    if (
      previous &&
      steps <= 1 &&
      previous.providerID === model.providerID &&
      previous.modelID === model.modelID
    ) {
      const sample = promptCacheSample(previous.at, info.time.created, info.tokens);
      if (sample) samples.push({ ...model, ...sample, at: info.time.created });
    }
    const lifetime = promptCacheLifetimeFor(providers, model);
    previous = {
      ...model,
      at: promptCacheUsedAt({ created: info.time.created, completed }, steps, lifetime),
    };
  }
  return samples.slice(-MAX_HISTORY_SAMPLES);
}

/** Lower bounds of the idle-gap buckets; the last one is open-ended. */
const GAP_BUCKETS_MS = [5, 10, 20, 30, 45, 60, 90, 120, 180, 360, 720, 1440].map(
  (minutes) => minutes * MINUTE
);
/** Buckets pool samples until they have this many before they count as evidence either way. */
const MIN_BUCKET_SAMPLES = 3;
/** Past this many samples a bucket halves its counts, so recent behavior outweighs old. */
const MAX_BUCKET_SAMPLES = 40;

/** `[hits, misses]` for each idle-gap bucket. */
export type PromptCacheHistogram = ReadonlyArray<readonly [number, number]>;

export function emptyPromptCacheHistogram(): PromptCacheHistogram {
  return GAP_BUCKETS_MS.map(() => [0, 0] as const);
}

function isSampleCount<T>(value: T): value is T & number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isHistogramBucket<T>(value: T): value is T & readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isSampleCount);
}

export function isPromptCacheHistogram(value: unknown): value is PromptCacheHistogram {
  return (
    Array.isArray(value) && value.length === GAP_BUCKETS_MS.length && value.every(isHistogramBucket)
  );
}

export function addPromptCacheSample(
  histogram: PromptCacheHistogram,
  sample: PromptCacheSample
): PromptCacheHistogram {
  let index = GAP_BUCKETS_MS.length - 1;
  while (index > 0 && sample.gapMs < GAP_BUCKETS_MS[index]!) index -= 1;
  return histogram.map(([hits, misses], bucket) => {
    if (bucket !== index) return [hits, misses] as const;
    const next = sample.hit ? ([hits + 1, misses] as const) : ([hits, misses + 1] as const);
    return next[0] + next[1] > MAX_BUCKET_SAMPLES
      ? ([Math.round(next[0] / 2), Math.round(next[1] / 2)] as const)
      : next;
  });
}

/**
 * How long caches usually last by the evidence: to the end of the longest idle gap that still found
 * them alive at least half the time, before the first gap where most requests missed. Neighboring
 * gaps with too few samples are pooled until they have enough. `undefined` until there is evidence.
 */
export function learnPromptCacheLifetime(
  histogram: PromptCacheHistogram
): LearnedPromptCacheLifetime | undefined {
  let survived: number | undefined;
  let pooledLower: number | undefined;
  let pooledHits = 0;
  let pooledMisses = 0;
  for (const [index, [hits, misses]] of histogram.entries()) {
    if (hits + misses === 0) continue;
    pooledLower ??= GAP_BUCKETS_MS[index]!;
    pooledHits += hits;
    pooledMisses += misses;
    if (pooledHits + pooledMisses < MIN_BUCKET_SAMPLES) continue;
    if (pooledMisses > pooledHits) return { ms: survived ?? pooledLower, bounded: true };
    survived = GAP_BUCKETS_MS[index + 1] ?? GAP_BUCKETS_MS[index]!;
    pooledLower = undefined;
    pooledHits = 0;
    pooledMisses = 0;
  }
  return survived === undefined ? undefined : { ms: survived, bounded: false };
}
