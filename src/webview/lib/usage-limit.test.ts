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
