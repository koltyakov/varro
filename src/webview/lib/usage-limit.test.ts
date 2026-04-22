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
