import type { ProviderLimitStatus, ProviderLimitUnit } from '../../shared/protocol';
import type { Message, Part, SessionStatus } from '../types';

export type UsageLimitNotice = {
  source: 'status' | 'message' | 'retry-part';
  statusCode: 429;
  message: string;
  unit: ProviderLimitUnit;
  retryAt: number | null;
  attempt: number | null;
  providerID?: string | null;
  modelID?: string | null;
};

export function parseUsageLimitNotice(
  message: string | null | undefined,
  options?: { retryAt?: number | null; attempt?: number | null }
): UsageLimitNotice | null {
  const normalizedMessage = message?.trim();
  if (!normalizedMessage) return null;

  const normalized = normalizedMessage.toLowerCase();
  const isLimitError =
    /(^|\b)429(\b|$)/.test(normalized) ||
    normalized.includes('usage limit') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests');
  if (!isLimitError) return null;

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
  messages: Array<{ info: Message; parts: Part[] }>;
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
    const entry = params.messages[messageIndex];
    if (entry.info.sessionID !== sessionID || entry.info.role !== 'assistant') continue;

    for (let partIndex = entry.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = entry.parts[partIndex];
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
  if (normalized.includes('rate limit')) return 'requests';
  if (normalized.includes('token')) return 'tokens';
  if (normalized.includes('credit') || normalized.includes('quota')) return 'credits';
  if (normalized.includes('usage limit')) return 'messages';
  return 'unknown';
}

function extractRetryAttempt(message: string) {
  const match = message.match(/attempt\s*#?\s*(\d+)/i);
  if (!match) return null;
  const attempt = Number(match[1]);
  return Number.isFinite(attempt) ? attempt : null;
}

function extractRetryAt(message: string) {
  const match = message.match(/retry(?:ing)?\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = match[2].toLowerCase();
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
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
