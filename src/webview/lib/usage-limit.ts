import type { ProviderLimitStatus, ProviderLimitUnit } from '../../shared/protocol';
import type { MessageEntry, SessionStatus } from '../types';

export type UsageLimitNotice = {
  source: 'status' | 'message' | 'retry-part';
  statusCode: 429;
  message: string;
  unit: ProviderLimitUnit;
  retryAt: number | null;
  attempt: number | null;
  sessionID?: string | null;
  providerID?: string | null;
  modelID?: string | null;
};

export function parseUsageLimitNotice(
  message: string | null | undefined,
  options?: { retryAt?: number | null; attempt?: number | null }
): UsageLimitNotice | null {
  const normalizedMessage = message?.trim();
  if (!normalizedMessage) return null;

  if (normalizedMessage.startsWith('{')) {
    const jsonNotice = parseJsonErrorBody(normalizedMessage, options);
    if (jsonNotice) return jsonNotice;
  }

  const normalized = normalizedMessage.toLowerCase();
  const isTextLimitError =
    /(^|\b)429(\b|$)/.test(normalized) ||
    normalized.includes('usage limit') ||
    normalized.includes('usage exceeded') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('rate increased too quickly') ||
    normalized.includes('overloaded') ||
    /\bexhausted\b/.test(normalized);

  if (!isTextLimitError) return null;

  return {
    source: 'message',
    statusCode: 429,
    message: normalizedMessage,
    unit: inferUsageLimitUnit(normalizedMessage),
    retryAt: normalizeRetryAt(options?.retryAt) ?? extractRetryAt(normalizedMessage),
    attempt: options?.attempt ?? extractRetryAttempt(normalizedMessage),
  };
}

export function deriveUsageLimitNotice(params: {
  sessionID: string | null | undefined;
  status: SessionStatus | null | undefined;
  messages: MessageEntry[];
}): UsageLimitNotice | null {
  const sessionID = params.sessionID;
  if (!sessionID) return null;

  const status = params.status;
  if (status?.type === 'retry') {
    const statusNotice = parseUsageLimitNotice(status.message, {
      retryAt: status.next || null,
      attempt: status.attempt,
    });
    if (statusNotice) {
      return { ...statusNotice, source: 'status' };
    }
  }

  for (let messageIndex = params.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const entry = params.messages[messageIndex]!;
    if (entry.info.sessionID !== sessionID || entry.info.role !== 'assistant') continue;

    const assistantNotice = parseUsageLimitNotice(
      entry.info.error?.data?.message || entry.info.error?.name,
      undefined
    );
    if (assistantNotice) {
      return {
        ...assistantNotice,
        source: 'message',
        providerID: entry.info.providerID,
        modelID: entry.info.modelID,
      };
    }

    if (!entry.info.error) {
      return null;
    }

    for (let partIndex = entry.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = entry.parts[partIndex]!;
      if (part.type !== 'retry') continue;
      const retryNotice = parseUsageLimitNotice(part.error?.data?.message, {
        attempt: part.attempt,
      });
      if (retryNotice) {
        return {
          ...retryNotice,
          source: 'retry-part',
          providerID: entry.info.providerID,
          modelID: entry.info.modelID,
        };
      }
    }
  }

  return null;
}

export function createUsageLimitProviderLimit(
  notice: UsageLimitNotice | null | undefined
): ProviderLimitStatus | null {
  if (!notice) return null;

  return {
    providerID: notice.providerID || 'usage-limit',
    modelID: notice.modelID,
    status: 'available',
    source: 'provider',
    checkedAt: Date.now(),
    note: notice.message,
    windows: [
      {
        id: notice.unit === 'unknown' ? 'limit' : notice.unit,
        label: getUsageLimitLabel(notice.unit),
        unit: notice.unit,
        remaining: 0,
        limit: null,
        resetAt: notice.retryAt,
      },
    ],
  };
}

function inferUsageLimitUnit(message: string): ProviderLimitUnit {
  const normalized = message.toLowerCase();
  if (normalized.includes('message')) return 'messages';
  if (normalized.includes('request')) return 'requests';
  if (normalized.includes('rate limit') || normalized.includes('rate increased')) return 'requests';
  if (normalized.includes('token')) return 'tokens';
  if (normalized.includes('credit') || normalized.includes('quota')) return 'credits';
  if (normalized.includes('usage limit') || normalized.includes('usage exceeded'))
    return 'messages';
  return 'unknown';
}

function extractRetryAttempt(message: string) {
  const match = message.match(/attempt\s*#?\s*(\d+)/i);
  if (!match) return null;
  const attempt = Number(match[1]);
  return Number.isFinite(attempt) ? attempt : null;
}

function extractRetryAt(message: string) {
  const match = message.match(
    /(?:retry(?:ing)?|try\s+again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)\b/i
  );
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unitStr = match[2]!.toLowerCase();
  const multiplier =
    unitStr === 'ms' || unitStr.startsWith('millisecond')
      ? 1
      : unitStr === 's' || unitStr.startsWith('second')
        ? 1000
        : unitStr === 'm' || unitStr.startsWith('minute')
          ? 60_000
          : 3_600_000;
  return Date.now() + Math.round(amount * multiplier);
}

function normalizeRetryAt(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value > 1_000_000_000_000) return Math.round(value);
  if (value > 1_000_000_000) return Math.round(value * 1000);
  if (value > 10_000) return Date.now() + Math.round(value);
  return Date.now() + Math.round(value * 1000);
}

function getUsageLimitLabel(unit: ProviderLimitUnit) {
  if (unit === 'messages') return 'Messages';
  if (unit === 'requests') return 'Requests';
  if (unit === 'tokens') return 'Tokens';
  if (unit === 'credits') return 'Credits';
  return 'Limit';
}

function parseJsonErrorBody(
  message: string,
  options?: { retryAt?: number | null; attempt?: number | null }
): UsageLimitNotice | null {
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    json = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const error = json.error as Record<string, unknown> | undefined;
  const code = typeof json.code === 'string' ? json.code : '';

  const isStructuredLimit =
    (json.type === 'error' && error?.type === 'too_many_requests') ||
    (json.type === 'error' &&
      typeof error?.code === 'string' &&
      error.code.includes('rate_limit')) ||
    code.includes('exhausted') ||
    code.includes('unavailable');

  if (!isStructuredLimit) return null;

  const displayMessage =
    (typeof error?.message === 'string' && error.message) ||
    (typeof json.message === 'string' && json.message) ||
    'Rate limited';

  return {
    source: 'message',
    statusCode: 429,
    message: displayMessage,
    unit: inferUsageLimitUnit(displayMessage),
    retryAt: normalizeRetryAt(options?.retryAt) ?? extractRetryAt(displayMessage),
    attempt: options?.attempt ?? extractRetryAttempt(displayMessage),
  };
}
