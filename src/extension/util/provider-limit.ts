import { homedir } from 'os';
import { join } from 'path';
import type {
  ProviderLimitStatus,
  ProviderLimitUnit,
  ProviderLimitWindow,
} from '../../shared/protocol';

export type ProviderAuthRecord =
  | { type: 'oauth'; access: string }
  | { type: 'api' | 'wellknown'; key: string };

type ProviderModel = {
  api?: {
    url?: string;
  };
};

export type ProviderMetadata = {
  id: string;
  options?: Record<string, unknown>;
  models: Record<string, ProviderModel>;
  [key: string]: unknown;
};

const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

const PROVIDER_LIMIT_PROBE_BASES: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  'github-copilot': 'https://api.githubcopilot.com',
};

const DIRECT_WINDOW_DEFS: Array<{ key: string; label: string; unit: ProviderLimitUnit }> = [
  { key: 'requests', label: 'Requests', unit: 'requests' },
  { key: 'tokens', label: 'Tokens', unit: 'tokens' },
  { key: 'messages', label: 'Messages', unit: 'messages' },
  { key: 'credits', label: 'Credits', unit: 'credits' },
];

const DIRECT_CONTAINER_KEYS = ['quota', 'usage', 'rateLimit', 'rateLimits', 'limits', 'billing'];

export function getOpenCodeAuthFilePath(env = process.env, home = homedir()) {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  return join(dataHome, 'opencode', 'auth.json');
}

export function parseRateLimitResetAt(value: unknown, checkedAt: number) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return Math.round(value);
    if (value > 1_000_000_000) return Math.round(value * 1000);
    return checkedAt + Math.round(value * 1000);
  }

  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
  if (!normalized) return null;

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return parseRateLimitResetAt(Number(normalized), checkedAt);
  }

  const duration = parseDurationMs(normalized);
  if (duration != null) return checkedAt + duration;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseProviderLimitHeaders(
  headers: Headers,
  checkedAt: number
): ProviderLimitWindow[] {
  const windows: ProviderLimitWindow[] = [];

  const requests = buildHeaderWindow(
    headers,
    checkedAt,
    'requests',
    'Requests',
    'requests',
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-reset-requests'
  );
  if (requests) windows.push(requests);

  const tokens = buildHeaderWindow(
    headers,
    checkedAt,
    'tokens',
    'Tokens',
    'tokens',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-tokens'
  );
  if (tokens) windows.push(tokens);

  const generic =
    buildHeaderWindow(
      headers,
      checkedAt,
      'limit',
      'Limit',
      'unknown',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset'
    ) ||
    buildHeaderWindow(
      headers,
      checkedAt,
      'limit',
      'Limit',
      'unknown',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset'
    );

  if (generic) windows.push(generic);
  return windows;
}

export function extractOpenCodeProviderLimit(
  provider: ProviderMetadata,
  modelID: string | null,
  checkedAt: number
): ProviderLimitStatus | null {
  if (modelID) {
    const modelWindows = extractDirectLimitWindows(provider.models[modelID], checkedAt);
    if (modelWindows.length > 0) {
      return {
        providerID: provider.id,
        modelID,
        status: 'available',
        source: 'opencode',
        checkedAt,
        windows: modelWindows,
        note: 'Read from OpenCode metadata',
      };
    }
  }

  const providerWindows = extractDirectLimitWindows(provider, checkedAt);
  if (providerWindows.length === 0) return null;

  return {
    providerID: provider.id,
    modelID,
    status: 'available',
    source: 'opencode',
    checkedAt,
    windows: providerWindows,
    note: 'Read from OpenCode metadata',
  };
}

export function extractOpenCodeConsoleLimit(
  payload: unknown,
  providerID: string,
  modelID: string | null,
  checkedAt: number
): ProviderLimitStatus | null {
  const record = asRecord(payload);
  const managed = Array.isArray(record?.consoleManagedProviders)
    ? record.consoleManagedProviders.filter((item): item is string => typeof item === 'string')
    : [];
  if (managed.length > 0 && !managed.includes(providerID)) return null;

  const windows = extractDirectLimitWindows(record, checkedAt);
  if (windows.length === 0) return null;

  return {
    providerID,
    modelID,
    status: 'available',
    source: 'opencode',
    checkedAt,
    windows,
    note: 'Read from OpenCode experimental console metadata',
  };
}

export function buildProviderLimitProbe(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
) {
  const baseUrl = getProviderApiBaseUrl(provider);
  const token = resolveProviderAuthToken(provider, authStore);
  if (!baseUrl || !token) return null;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };

  if (provider.id === 'github-copilot') {
    headers['User-Agent'] = 'Varro/0.1.0';
    headers['Editor-Version'] = 'vscode/1.91.0';
    headers['Editor-Plugin-Version'] = 'varro/0.1.0';
  }

  return {
    url: `${baseUrl.replace(/\/+$/, '')}/models`,
    headers,
  };
}

export function parseProviderAuthStore(raw: string): Record<string, ProviderAuthRecord> {
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);
  if (!record) return {};

  const authStore: Record<string, ProviderAuthRecord> = {};
  for (const [providerID, value] of Object.entries(record)) {
    const auth = asRecord(value);
    if (!auth) continue;

    if (auth.type === 'oauth' && typeof auth.access === 'string' && auth.access.trim()) {
      authStore[providerID] = { type: 'oauth', access: auth.access.trim() };
      continue;
    }

    if (
      (auth.type === 'api' || auth.type === 'wellknown') &&
      typeof auth.key === 'string' &&
      auth.key.trim()
    ) {
      authStore[providerID] = { type: auth.type, key: auth.key.trim() };
    }
  }

  return authStore;
}

function extractDirectLimitWindows(value: unknown, checkedAt: number) {
  const windows: ProviderLimitWindow[] = [];
  const seen = new Set<string>();

  const pushWindow = (window: ProviderLimitWindow | null) => {
    if (!window || seen.has(window.id)) return;
    seen.add(window.id);
    windows.push(window);
  };

  const record = asRecord(value);
  if (!record) return windows;

  for (const def of DIRECT_WINDOW_DEFS) {
    pushWindow(
      buildDirectWindow(def.key, def.label, def.unit, asRecord(record[def.key]), checkedAt)
    );
  }

  pushWindow(buildDirectWindow('limit', 'Limit', 'unknown', record, checkedAt));

  for (const containerKey of DIRECT_CONTAINER_KEYS) {
    const container = record[containerKey];
    if (Array.isArray(container)) {
      for (const item of container) {
        const itemRecord = asRecord(item);
        if (!itemRecord) continue;
        const id =
          getString(itemRecord.id) || getString(itemRecord.name) || getString(itemRecord.type);
        const unit = inferLimitUnit(id);
        pushWindow(
          buildDirectWindow(
            id || containerKey,
            toLabel(id || containerKey),
            unit,
            itemRecord,
            checkedAt
          )
        );
      }
      continue;
    }

    const containerRecord = asRecord(container);
    if (!containerRecord) continue;

    pushWindow(
      buildDirectWindow(
        containerKey,
        toLabel(containerKey),
        inferLimitUnit(containerKey),
        containerRecord,
        checkedAt
      )
    );

    for (const [key, nested] of Object.entries(containerRecord)) {
      pushWindow(
        buildDirectWindow(key, toLabel(key), inferLimitUnit(key), asRecord(nested), checkedAt)
      );
    }
  }

  return windows;
}

function buildHeaderWindow(
  headers: Headers,
  checkedAt: number,
  id: string,
  label: string,
  unit: ProviderLimitUnit,
  limitHeader: string,
  remainingHeader: string,
  resetHeader: string
) {
  const remaining = parseFiniteNumber(headers.get(remainingHeader));
  if (remaining == null) return null;

  return {
    id,
    label,
    unit,
    remaining,
    limit: parseFiniteNumber(headers.get(limitHeader)),
    resetAt: parseRateLimitResetAt(headers.get(resetHeader), checkedAt),
  } satisfies ProviderLimitWindow;
}

function buildDirectWindow(
  id: string,
  label: string,
  unit: ProviderLimitUnit,
  record: Record<string, unknown> | null,
  checkedAt: number
) {
  if (!record) return null;

  const remaining =
    parseFiniteNumber(record.remaining) ??
    parseFiniteNumber(record.left) ??
    parseFiniteNumber(record.available) ??
    parseFiniteNumber(record.remainingCount);
  if (remaining == null) return null;

  return {
    id,
    label,
    unit,
    remaining,
    limit:
      parseFiniteNumber(record.limit) ??
      parseFiniteNumber(record.max) ??
      parseFiniteNumber(record.total) ??
      parseFiniteNumber(record.quota) ??
      null,
    resetAt: parseRateLimitResetAt(
      record.resetAt ?? record.reset ?? record.resetsAt ?? record.reset_after,
      checkedAt
    ),
  } satisfies ProviderLimitWindow;
}

function getProviderApiBaseUrl(provider: ProviderMetadata) {
  return PROVIDER_LIMIT_PROBE_BASES[provider.id] || null;
}

function resolveProviderAuthToken(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
) {
  const auth = authStore[provider.id];
  if (auth?.type === 'oauth') return auth.access;
  if (auth && 'key' in auth) return auth.key;

  const apiKey = getString(asRecord(provider.options)?.apiKey);
  if (!apiKey || apiKey === OPENCODE_OAUTH_DUMMY_KEY) return null;
  return apiKey;
}

function parseDurationMs(value: string) {
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (matches.length === 0 || matches.map((match) => match[0]).join('') !== value) {
    return null;
  }

  let total = 0;
  for (const [, amountText, unit] of matches) {
    const amount = Number(amountText);
    if (!Number.isFinite(amount)) return null;
    if (unit === 'ms') total += amount;
    else if (unit === 's') total += amount * 1000;
    else if (unit === 'm') total += amount * 60_000;
    else if (unit === 'h') total += amount * 3_600_000;
    else if (unit === 'd') total += amount * 86_400_000;
  }
  return Math.round(total);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferLimitUnit(value: string | null | undefined): ProviderLimitUnit {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) return 'unknown';
  if (normalized.includes('request')) return 'requests';
  if (normalized.includes('token')) return 'tokens';
  if (normalized.includes('message')) return 'messages';
  if (normalized.includes('credit') || normalized.includes('balance')) return 'credits';
  return 'unknown';
}

function toLabel(value: string) {
  return (
    value
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit'
  );
}
