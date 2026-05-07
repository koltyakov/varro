import { describe, expect, it } from 'vitest';
import {
  createUsageLimitProviderLimit,
  deriveUsageLimitNotice,
  parseUsageLimitNotice,
} from './usage-limit';

describe('usage limit helpers', () => {
  it('detects 429 usage-limit messages and infers message units', () => {
    const notice = parseUsageLimitNotice(
      '429 The usage limit has been reached [retrying in 3s attempt #3]'
    );

    expect(notice).toMatchObject({
      statusCode: 429,
      unit: 'messages',
      attempt: 3,
    });
    expect(notice?.retryAt).not.toBeNull();
  });

  it('derives a usage-limit notice from retry session status before message errors', () => {
    const notice = deriveUsageLimitNotice({
      sessionID: 'session-1',
      status: {
        type: 'retry',
        attempt: 2,
        message: '429 rate limit reached',
        next: 3,
      },
      messages: [],
    });

    expect(notice).toMatchObject({
      source: 'status',
      attempt: 2,
      unit: 'requests',
    });
    expect(notice?.retryAt).not.toBeNull();
  });

  it('drops stale retry-part notices once a newer assistant message resumes without an error', () => {
    const notice = deriveUsageLimitNotice({
      sessionID: 'session-1',
      status: { type: 'idle' },
      messages: [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
            error: { name: 'Usage limit reached', data: { message: '429 usage limit reached' } },
            parentID: 'user-1',
            modelID: 'gpt-5.4',
            providerID: 'openai',
            mode: 'default',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [
            {
              id: 'retry-1',
              sessionID: 'session-1',
              messageID: 'assistant-1',
              type: 'retry',
              attempt: 1,
              error: { name: '429', data: { message: '429 usage limit reached' } },
              time: { created: 1 },
            },
          ],
        },
        {
          info: {
            id: 'assistant-2',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 3 },
            parentID: 'user-2',
            modelID: 'gpt-5.4',
            providerID: 'openai',
            mode: 'default',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        },
      ],
    });

    expect(notice).toBeNull();
  });

  // -- parseUsageLimitNotice edge cases --

  it('returns null for null, undefined, and empty string input', () => {
    expect(parseUsageLimitNotice(null)).toBeNull();
    expect(parseUsageLimitNotice(undefined)).toBeNull();
    expect(parseUsageLimitNotice('')).toBeNull();
    expect(parseUsageLimitNotice('   ')).toBeNull();
  });

  it('returns null for a message that does not match any limit pattern', () => {
    expect(parseUsageLimitNotice('everything is fine')).toBeNull();
    expect(parseUsageLimitNotice('server error 500')).toBeNull();
  });

  it('detects "too many requests" pattern', () => {
    const notice = parseUsageLimitNotice('too many requests, slow down');
    expect(notice).not.toBeNull();
    expect(notice?.statusCode).toBe(429);
    expect(notice?.unit).toBe('requests');
  });

  it('detects "rate limit" message and infers unit as requests', () => {
    const notice = parseUsageLimitNotice('rate limit exceeded');
    expect(notice).not.toBeNull();
    expect(notice?.unit).toBe('requests');
  });

  it('infers unit "tokens" when message contains "token"', () => {
    const notice = parseUsageLimitNotice('429 token limit exceeded');
    expect(notice).not.toBeNull();
    expect(notice?.unit).toBe('tokens');
  });

  it('infers unit "credits" when message contains "credit"', () => {
    const notice = parseUsageLimitNotice('429 credit exhausted');
    expect(notice?.unit).toBe('credits');
  });

  it('infers unit "credits" when message contains "quota"', () => {
    const notice = parseUsageLimitNotice('429 quota exceeded');
    expect(notice?.unit).toBe('credits');
  });

  it('infers unit "unknown" when no unit hint is present', () => {
    const notice = parseUsageLimitNotice('429 slow down');
    expect(notice?.unit).toBe('unknown');
  });

  it('extracts retryAt from "retry in 500ms"', () => {
    const before = Date.now();
    const notice = parseUsageLimitNotice('429 retry in 500ms');
    expect(notice?.retryAt).toBeGreaterThanOrEqual(before + 500);
  });

  it('extracts retryAt from "retry in 2m"', () => {
    const before = Date.now();
    const notice = parseUsageLimitNotice('429 retry in 2m');
    expect(notice?.retryAt).toBeGreaterThanOrEqual(before + 2 * 60_000);
  });

  it('extracts retryAt from "retry in 1h"', () => {
    const before = Date.now();
    const notice = parseUsageLimitNotice('429 retry in 1h');
    expect(notice?.retryAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it('returns retryAt null when retry amount is non-finite', () => {
    // No retry pattern at all → null
    const notice = parseUsageLimitNotice('429 please wait');
    expect(notice?.retryAt).toBeNull();
  });

  it('uses explicit retryAt and attempt from options', () => {
    const notice = parseUsageLimitNotice('429 retry in 5s attempt #1', {
      retryAt: 1_700_000_000_000,
      attempt: 99,
    });
    // retryAt > 1_000_000_000_000 → treated as ms timestamp, rounded
    expect(notice?.retryAt).toBe(1_700_000_000_000);
    expect(notice?.attempt).toBe(99);
  });

  // -- normalizeRetryAt via options.retryAt --

  it('normalizes retryAt as ms timestamp (> 1_000_000_000_000)', () => {
    const ts = 1_700_000_000_001.7;
    const notice = parseUsageLimitNotice('429 error', { retryAt: ts });
    expect(notice?.retryAt).toBe(Math.round(ts));
  });

  it('normalizes retryAt as second timestamp (> 1_000_000_000)', () => {
    const ts = 1_700_000_000;
    const notice = parseUsageLimitNotice('429 error', { retryAt: ts });
    expect(notice?.retryAt).toBe(Math.round(ts * 1000));
  });

  it('normalizes retryAt as ms offset (> 10_000)', () => {
    const before = Date.now();
    const notice = parseUsageLimitNotice('429 error', { retryAt: 30_000 });
    expect(notice?.retryAt).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('normalizes retryAt as second offset (<= 10_000)', () => {
    const before = Date.now();
    const notice = parseUsageLimitNotice('429 error', { retryAt: 5 });
    expect(notice?.retryAt).toBeGreaterThanOrEqual(before + 5_000);
  });

  it('normalizes retryAt null for NaN', () => {
    const notice = parseUsageLimitNotice('429 error', { retryAt: NaN });
    // Falls through to extractRetryAt which finds nothing → null
    expect(notice?.retryAt).toBeNull();
  });

  it('normalizes retryAt null for undefined', () => {
    const notice = parseUsageLimitNotice('429 error', { retryAt: undefined });
    expect(notice?.retryAt).toBeNull();
  });

  // -- deriveUsageLimitNotice edge cases --

  it('returns null when sessionID is null', () => {
    const notice = deriveUsageLimitNotice({
      sessionID: null,
      status: null,
      messages: [],
    });
    expect(notice).toBeNull();
  });

  it('returns null when status is not retry and no matching messages', () => {
    const notice = deriveUsageLimitNotice({
      sessionID: 'session-1',
      status: { type: 'idle' },
      messages: [],
    });
    expect(notice).toBeNull();
  });

  it('returns notice from assistant message error.data.message matching 429', () => {
    const notice = deriveUsageLimitNotice({
      sessionID: 'session-1',
      status: { type: 'idle' },
      messages: [
        {
          info: {
            id: 'a-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1 },
            error: { name: 'Error', data: { message: '429 token limit' } },
            parentID: 'u-1',
            modelID: 'model-1',
            providerID: 'provider-1',
            mode: 'default',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [],
        },
      ],
    });
    expect(notice).toMatchObject({
      source: 'message',
      providerID: 'provider-1',
      modelID: 'model-1',
      unit: 'tokens',
    });
  });

  it('returns notice from retry part with error.data.message matching 429', () => {
    const notice = deriveUsageLimitNotice({
      sessionID: 'session-1',
      status: { type: 'idle' },
      messages: [
        {
          info: {
            id: 'a-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1 },
            error: { name: 'some error', data: {} },
            parentID: 'u-1',
            modelID: 'model-x',
            providerID: 'provider-x',
            mode: 'default',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: 'r-1',
              sessionID: 'session-1',
              messageID: 'a-1',
              type: 'retry' as const,
              attempt: 3,
              error: { name: '429', data: { message: '429 rate limit' } },
              time: { created: 1 },
            },
          ],
        },
      ],
    });
    expect(notice).toMatchObject({
      source: 'retry-part',
      providerID: 'provider-x',
      modelID: 'model-x',
      unit: 'requests',
      attempt: 3,
    });
  });

  it('skips messages from a different sessionID', () => {
    const notice = deriveUsageLimitNotice({
      sessionID: 'session-1',
      status: { type: 'idle' },
      messages: [
        {
          info: {
            id: 'a-1',
            sessionID: 'other-session',
            role: 'assistant',
            time: { created: 1 },
            error: { name: '429', data: { message: '429 usage limit' } },
            parentID: 'u-1',
            modelID: 'model-1',
            providerID: 'provider-1',
            mode: 'default',
            path: { cwd: '/', root: '/' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [],
        },
      ],
    });
    expect(notice).toBeNull();
  });

  // -- createUsageLimitProviderLimit edge cases --

  it('returns null for null/undefined input to createUsageLimitProviderLimit', () => {
    expect(createUsageLimitProviderLimit(null)).toBeNull();
    expect(createUsageLimitProviderLimit(undefined)).toBeNull();
  });

  it('uses window id "limit" and label "Limit" when unit is "unknown"', () => {
    const limit = createUsageLimitProviderLimit({
      source: 'message',
      statusCode: 429,
      message: '429 slow down',
      unit: 'unknown',
      retryAt: null,
      attempt: null,
    });
    expect(limit?.windows[0]).toMatchObject({
      id: 'limit',
      label: 'Limit',
      unit: 'unknown',
    });
  });

  it('uses window id "tokens" and label "Tokens" when unit is "tokens"', () => {
    const limit = createUsageLimitProviderLimit({
      source: 'message',
      statusCode: 429,
      message: '429 token limit',
      unit: 'tokens',
      retryAt: null,
      attempt: null,
    });
    expect(limit?.windows[0]).toMatchObject({
      id: 'tokens',
      label: 'Tokens',
    });
  });

  it('uses label "Credits" when unit is "credits"', () => {
    const limit = createUsageLimitProviderLimit({
      source: 'message',
      statusCode: 429,
      message: '429 credits exhausted',
      unit: 'credits',
      retryAt: null,
      attempt: null,
    });
    expect(limit?.windows[0]).toMatchObject({
      id: 'credits',
      label: 'Credits',
    });
  });

  it('uses label "Requests" when unit is "requests"', () => {
    const limit = createUsageLimitProviderLimit({
      source: 'message',
      statusCode: 429,
      message: '429 rate limit',
      unit: 'requests',
      retryAt: null,
      attempt: null,
    });
    expect(limit?.windows[0]).toMatchObject({
      id: 'requests',
      label: 'Requests',
    });
  });

  it('uses "usage-limit" as default providerID when notice has no providerID', () => {
    const limit = createUsageLimitProviderLimit({
      source: 'message',
      statusCode: 429,
      message: '429 error',
      unit: 'messages',
      retryAt: null,
      attempt: null,
    });
    expect(limit?.providerID).toBe('usage-limit');
  });

  it('creates a synthetic exhausted provider limit for usage-limit banners', () => {
    const limit = createUsageLimitProviderLimit({
      source: 'message',
      statusCode: 429,
      message: 'Usage limit reached',
      unit: 'messages',
      retryAt: 123_000,
      attempt: 1,
      providerID: 'github-copilot',
      modelID: 'gpt-5.4',
    });

    expect(limit).toEqual({
      providerID: 'github-copilot',
      modelID: 'gpt-5.4',
      status: 'available',
      source: 'provider',
      checkedAt: expect.any(Number),
      note: 'Usage limit reached',
      windows: [
        {
          id: 'messages',
          label: 'Messages',
          unit: 'messages',
          remaining: 0,
          limit: null,
          resetAt: 123_000,
        },
      ],
    });
  });
});
