/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- The local provider descriptor and response are untrusted protocol values. */
import type {
  ProviderLimitResetCredits,
  ProviderLimitStatus,
  ProviderLimitUnit,
  ProviderLimitWindow,
} from '../../../shared/protocol';
import { asRecord } from '../../../shared/type-utils';
import type { ProviderMetadata } from '../../util/provider-limit';
import { readBoundedResponseJson, unsupportedProviderStatus } from '../adapter-utils';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';

const PROVIDER_ID = 'claude-code';
const REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_LIMIT_UNITS = new Set<string>([
  'requests',
  'tokens',
  'messages',
  'credits',
  'usd',
  'unknown',
]);

type ProviderLimitDescriptor = {
  url: string;
  token: string;
};

export function createOpenCodeClaudeAdapter(): ProviderLimitAdapter {
  return {
    id: PROVIDER_ID,
    capabilities: { localIpc: true },
    matches(provider) {
      return provider.id === PROVIDER_ID && getProviderLimitDescriptor(provider) != null;
    },
    async fetch({ provider, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const descriptor = getProviderLimitDescriptor(provider);
      if (provider.id !== PROVIDER_ID || !descriptor) {
        return unsupportedProviderStatus(
          PROVIDER_ID,
          modelID,
          checkedAt,
          'Claude Code provider-limit endpoint is not configured safely'
        );
      }

      try {
        const response = await fetch(descriptor.url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${descriptor.token}`,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            PROVIDER_ID,
            modelID,
            checkedAt,
            `Claude Code provider-limit endpoint rejected credentials (${response.status})`
          );
        }
        if (!response.ok) {
          return errorStatus(
            modelID,
            checkedAt,
            `Claude Code provider-limit endpoint returned ${response.status}`
          );
        }

        const providerLimit = parseProviderLimitResponse(await readBoundedResponseJson(response));
        if (!providerLimit) {
          return errorStatus(
            modelID,
            checkedAt,
            'Claude Code provider-limit endpoint returned an invalid response'
          );
        }

        return {
          ...providerLimit,
          providerID: PROVIDER_ID,
          modelID,
          checkedAt,
        };
      } catch {
        return errorStatus(
          modelID,
          checkedAt,
          'Failed to poll the Claude Code provider-limit endpoint'
        );
      }
    },
  };
}

function getProviderLimitDescriptor(provider: ProviderMetadata): ProviderLimitDescriptor | null {
  const namespace = asRecord(asRecord(provider.options)?.[PROVIDER_ID]);
  const descriptor = asRecord(namespace?.providerLimits);
  if (
    descriptor?.schemaVersion !== 1 ||
    descriptor.transport !== 'http' ||
    typeof descriptor.url !== 'string' ||
    typeof descriptor.token !== 'string' ||
    descriptor.token.length === 0 ||
    !isSafeLoopbackUrl(descriptor.url)
  ) {
    return null;
  }
  return { url: descriptor.url, token: descriptor.token };
}

function isSafeLoopbackUrl(value: string) {
  try {
    const url = new URL(value);
    const authority = /^http:\/\/([^/?#]*)/i.exec(value)?.[1];
    return (
      url.protocol === 'http:' &&
      typeof authority === 'string' &&
      /^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority) &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function parseProviderLimitResponse(value: unknown): ProviderLimitStatus | null {
  const response = asRecord(value);
  if (response?.schemaVersion !== 1) return null;
  return parseProviderLimit(response.providerLimit);
}

function parseProviderLimit(value: unknown): ProviderLimitStatus | null {
  const limit = asRecord(value);
  if (
    !limit ||
    limit.providerID !== PROVIDER_ID ||
    limit.modelID !== null ||
    limit.source !== 'provider' ||
    !isNonNegativeFiniteNumber(limit.checkedAt)
  ) {
    return null;
  }

  if (limit.status === 'unsupported' || limit.status === 'error') {
    if (typeof limit.note !== 'string' || limit.note.length === 0) return null;
    return {
      providerID: PROVIDER_ID,
      modelID: null,
      status: limit.status,
      source: limit.source,
      checkedAt: limit.checkedAt,
      note: limit.note,
    };
  }
  if (limit.status !== 'available' || !Array.isArray(limit.windows) || limit.windows.length === 0)
    return null;

  const windows: ProviderLimitWindow[] = [];
  for (const windowValue of limit.windows) {
    const window = parseProviderLimitWindow(windowValue);
    if (!window) return null;
    windows.push(window);
  }
  const planName = parseOptionalString(limit.planName);
  const note = parseOptionalString(limit.note);
  const usageLimitResets = parseUsageLimitResets(limit.usageLimitResets);
  if (planName === false || note === false || usageLimitResets === false) return null;

  const parsed: Extract<ProviderLimitStatus, { status: 'available' }> = {
    providerID: PROVIDER_ID,
    modelID: null,
    status: 'available',
    source: limit.source,
    checkedAt: limit.checkedAt,
    windows,
  };
  if (planName !== undefined) parsed.planName = planName;
  if (note !== undefined) parsed.note = note;
  if (usageLimitResets !== undefined) parsed.usageLimitResets = usageLimitResets;
  return parsed;
}

function parseProviderLimitWindow(value: unknown): ProviderLimitWindow | null {
  const window = asRecord(value);
  if (
    !window ||
    typeof window.id !== 'string' ||
    window.id.length === 0 ||
    typeof window.label !== 'string' ||
    window.label.length === 0 ||
    typeof window.unit !== 'string' ||
    !isProviderLimitUnit(window.unit) ||
    !isNonNegativeFiniteNumber(window.remaining) ||
    !(window.limit === null || isNonNegativeFiniteNumber(window.limit)) ||
    !(window.resetAt === null || isNonNegativeFiniteNumber(window.resetAt)) ||
    !(
      window.percent === undefined ||
      window.percent === null ||
      (isNonNegativeFiniteNumber(window.percent) && window.percent <= 100)
    )
  ) {
    return null;
  }

  const parsed: ProviderLimitWindow = {
    id: window.id,
    label: window.label,
    unit: window.unit,
    remaining: window.remaining,
    limit: window.limit,
    resetAt: window.resetAt,
  };
  if (window.percent !== undefined) parsed.percent = window.percent;
  return parsed;
}

function parseUsageLimitResets(value: unknown): ProviderLimitResetCredits | undefined | false {
  if (value === undefined) return undefined;
  const resets = asRecord(value);
  if (
    !resets ||
    !Number.isSafeInteger(resets.availableCount) ||
    !isNonNegativeFiniteNumber(resets.availableCount) ||
    !(resets.credits === null || Array.isArray(resets.credits))
  ) {
    return false;
  }
  if (resets.credits === null) {
    return { availableCount: resets.availableCount, credits: null };
  }

  const credits: Array<{ title: string; expiresAt: number | null }> = [];
  for (const creditValue of resets.credits) {
    const credit = asRecord(creditValue);
    if (
      !credit ||
      typeof credit.title !== 'string' ||
      credit.title.length === 0 ||
      !(credit.expiresAt === null || isNonNegativeFiniteNumber(credit.expiresAt))
    ) {
      return false;
    }
    credits.push({ title: credit.title, expiresAt: credit.expiresAt });
  }
  return { availableCount: resets.availableCount, credits };
}

function parseOptionalString(value: unknown): string | undefined | false {
  return value === undefined ? undefined : typeof value === 'string' ? value : false;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isProviderLimitUnit(value: string): value is ProviderLimitUnit {
  return PROVIDER_LIMIT_UNITS.has(value);
}

function errorStatus(modelID: string | null, checkedAt: number, note: string): ProviderLimitStatus {
  return {
    providerID: PROVIDER_ID,
    modelID,
    status: 'error',
    source: 'provider',
    checkedAt,
    note,
  };
}
