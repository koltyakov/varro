import type { ProviderLimitStatus, ProviderLimitUnit } from '../../shared/protocol';
import type { MessageEntry, SessionStatus } from '../types';
import { asRecord, isString, type UnknownRecord, isObject } from './runtime-values';

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
  action?: NonNullable<Extract<SessionStatus, { type: 'retry' }>['action']>;
};

export type UsageLimitPresentation = {
  title: string;
  summary: string;
};

const SILENT_SERVICE_RETRY_ATTEMPTS = 3;

export function getUsageLimitPresentation(
  notice: Pick<UsageLimitNotice, 'message' | 'unit' | 'action'>
): UsageLimitPresentation {
  const actionTitle = notice.action?.title.trim();
  const normalized = notice.message.toLowerCase();
  if (isServiceUnavailableMessage(notice.message)) {
    return {
      title: actionTitle || 'Service temporarily unavailable',
      summary: 'service disruption',
    };
  }

  const isQuotaExhausted =
    normalized.includes('usage limit') ||
    normalized.includes('usage exceeded') ||
    /\b(?:messages?|tokens?|credits?|quota)\b.*\b(?:exhausted|exceeded|limit)\b/.test(normalized);

  if (isQuotaExhausted) {
    return {
      title: actionTitle || 'Usage limit reached',
      summary: `${getUsageLimitLabel(notice.unit).toLowerCase()} exhausted`,
    };
  }

  return {
    title: actionTitle || 'Request throttled',
    summary: 'request throttled',
  };
}

export function getSafeUsageLimitAction(
  action: UsageLimitNotice['action']
): { label: string; link: string } | null {
  const label = action?.label.trim();
  const link = action?.link?.trim();
  if (!label || !link) return null;

  try {
    return new URL(link).protocol === 'https:' ? { label, link } : null;
  } catch {
    return null;
  }
}

export function shouldDisplayUsageLimitNotice(
  notice: Pick<UsageLimitNotice, 'message' | 'attempt'>
): boolean {
  return (
    !isServiceUnavailableMessage(notice.message) ||
    notice.attempt === null ||
    notice.attempt > SILENT_SERVICE_RETRY_ATTEMPTS
  );
}

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
    isServiceUnavailableMessage(normalizedMessage) ||
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
      return { ...statusNotice, source: 'status', action: status.action };
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

function isServiceUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('overloaded') ||
    normalized.includes('service unavailable') ||
    normalized.includes('server unavailable') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('server is busy') ||
    normalized.includes('servers are busy') ||
    normalized.includes('at capacity')
  );
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
  let json: UnknownRecord;
  try {
    const parsed = JSON.parse(message);
    if (!parsed || !isObject(parsed) || Array.isArray(parsed)) return null;
    // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
    json = parsed as UnknownRecord;
  } catch {
    return null;
  }

  const error = asRecord(json.error) ?? undefined;
  const code = isString(json.code) ? json.code : '';

  const isStructuredLimit =
    (json.type === 'error' && error?.type === 'too_many_requests') ||
    (json.type === 'error' && isString(error?.code) && error.code.includes('rate_limit')) ||
    code.includes('exhausted') ||
    code.includes('unavailable');

  if (!isStructuredLimit) return null;

  const fallbackMessage = code.includes('unavailable')
    ? 'Service temporarily unavailable'
    : 'Rate limited';
  const displayMessage =
    (isString(error?.message) && error.message) ||
    (isString(json.message) && json.message) ||
    fallbackMessage;

  return {
    source: 'message',
    statusCode: 429,
    message: displayMessage,
    unit: inferUsageLimitUnit(displayMessage),
    retryAt: normalizeRetryAt(options?.retryAt) ?? extractRetryAt(displayMessage),
    attempt: options?.attempt ?? extractRetryAttempt(displayMessage),
  };
}

/**
 * Decides whether a usage-limit notice still applies to what the composer is pointed at.
 *
 * A notice raised for one provider or model should disappear once the user switches away, but a
 * notice with no provider or model attached applies broadly, and a live status notice stays
 * visible while an assistant turn is still on screen.
 */
export function isUsageLimitNoticeVisibleForModel(
  notice: UsageLimitNotice | null | undefined,
  currentModel: { providerID?: string | null; modelID?: string | null },
  hasActiveAssistantContext: boolean
): boolean {
  if (!notice) return false;
  if (!notice.providerID && !notice.modelID) return true;
  if (hasActiveAssistantContext && notice.source === 'status') return true;
  if (notice.providerID && notice.providerID !== currentModel.providerID) return false;
  if (notice.modelID && notice.modelID !== currentModel.modelID) return false;
  return true;
}
