import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ProviderLimitWindow } from '../../../shared/protocol';
import {
  parseRateLimitResetAt,
  type ProviderAuthRecord,
  type ProviderMetadata,
} from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  getString,
  parseFiniteNumber,
  clampPercent,
  toLabel,
  unsupportedProviderStatus,
} from '../adapter-utils';

const COPILOT_USER_ENDPOINT = 'https://api.github.com/copilot_internal/user';
const GITHUB_HOSTS_FILE_PATH = join(homedir(), '.config', 'gh', 'hosts.yml');
const OPENCODE_OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key';

const COPILOT_QUOTA_LABELS: Record<string, string> = {
  premium_interactions: 'Premium Requests',
  chat: 'Chat',
  completions: 'Completions',
};

const COPILOT_MONTHLY_QUOTA_LABELS: Record<string, string> = {
  premium_interactions: 'Monthly Premium Requests',
  chat: 'Monthly Chat',
  completions: 'Monthly Completions',
};

export function createCopilotAdapter(): ProviderLimitAdapter {
  return {
    id: 'github-copilot',
    matches(provider) {
      return provider.id === 'github-copilot';
    },
    async fetch({ provider, authStore, modelID, checkedAt }: ProviderLimitAdapterContext) {
      const token = await resolveCopilotAuthToken(provider, authStore);
      if (!token) {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No GitHub Copilot credentials available'
        );
      }

      try {
        const response = await fetch(COPILOT_USER_ENDPOINT, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Varro/0.1.0',
            'Editor-Version': 'vscode/1.91.0',
            'Editor-Plugin-Version': 'varro/0.1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `GitHub Copilot quota endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `GitHub Copilot quota endpoint returned ${response.status}`,
          };
        }

        const payload = (await response.json()) as unknown;
        const windows = extractCopilotWindows(payload, checkedAt);
        if (windows.length === 0) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'GitHub Copilot quota endpoint did not expose any bounded quotas'
          );
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          note: 'Polled GitHub Copilot internal quota endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the GitHub Copilot quota endpoint',
        };
      }
    },
  };
}

function extractCopilotWindows(payload: unknown, checkedAt: number): ProviderLimitWindow[] {
  const record = asRecord(payload);
  if (!record) return [];

  const resetAt = getCopilotResetAt(record, checkedAt);
  const snapshots = normalizeCopilotQuotaSnapshots(record);
  const windows: ProviderLimitWindow[] = [];

  for (const [id, snapshot] of Object.entries(snapshots)) {
    const window = buildCopilotWindow(id, snapshot, resetAt);
    if (window) windows.push(window);
  }

  return windows.toSorted((a, b) => a.label.localeCompare(b.label));
}

function buildCopilotWindow(
  id: string,
  snapshot: Record<string, unknown>,
  resetAt: number | null
): ProviderLimitWindow | null {
  if (snapshot.unlimited === true) return null;

  const remaining = parseFiniteNumber(snapshot.remaining);
  if (remaining == null) return null;

  const limit = parseFiniteNumber(snapshot.entitlement);
  const percentRemaining = parseFiniteNumber(snapshot.percent_remaining);
  const percent =
    percentRemaining != null
      ? clampPercent(100 - percentRemaining)
      : limit != null && limit > 0
        ? clampPercent((1 - remaining / limit) * 100)
        : null;

  if ((limit == null || limit <= 0) && percent == null) {
    return null;
  }

  return {
    id,
    label: COPILOT_MONTHLY_QUOTA_LABELS[id] ?? COPILOT_QUOTA_LABELS[id] ?? `Monthly ${toLabel(id)}`,
    unit: id === 'chat' ? 'messages' : 'requests',
    remaining,
    limit: limit != null && limit > 0 ? limit : null,
    resetAt,
    ...(percent == null ? {} : { percent }),
  } satisfies ProviderLimitWindow;
}

function normalizeCopilotQuotaSnapshots(record: Record<string, unknown>) {
  const legacySnapshots = asNestedRecordMap(record.quota_snapshots);
  if (Object.keys(legacySnapshots).length > 0) return legacySnapshots;

  const usedQuotas = asUnknownMap(record.limited_user_quotas);
  const monthlyQuotas = asUnknownMap(record.monthly_quotas);
  if (Object.keys(usedQuotas).length === 0) return {};

  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [id, usedValue] of Object.entries(usedQuotas)) {
    const used = parseFiniteNumber(usedValue);
    const monthly = parseFiniteNumber(monthlyQuotas[id]);
    if (used == null || monthly == null || monthly <= 0) continue;

    const remaining = Math.max(monthly - used, 0);
    normalized[id] = {
      entitlement: monthly,
      remaining,
      percent_remaining: monthly > 0 ? (remaining / monthly) * 100 : null,
      unlimited: false,
    };
  }

  return normalized;
}

function getCopilotResetAt(record: Record<string, unknown>, checkedAt: number) {
  const resetValue =
    getString(record.quota_reset_date_utc) ||
    toUtcMidnightDate(getString(record.limited_user_reset_date)) ||
    null;
  return parseRateLimitResetAt(resetValue, checkedAt);
}

async function resolveCopilotAuthToken(
  provider: ProviderMetadata,
  authStore: Record<string, ProviderAuthRecord>
) {
  const auth = authStore[provider.id];
  if (auth?.type === 'oauth') return auth.access;
  if (auth && 'key' in auth) return auth.key;

  const apiKey = getString(asRecord(provider.options)?.apiKey);
  if (apiKey && apiKey !== OPENCODE_OAUTH_DUMMY_KEY) return apiKey;

  return readCopilotTokenFromGhHosts();
}

async function readCopilotTokenFromGhHosts() {
  try {
    const raw = await readFile(GITHUB_HOSTS_FILE_PATH, 'utf-8');
    return parseGhHostsOauthToken(raw);
  } catch {
    return null;
  }
}

function parseGhHostsOauthToken(raw: string) {
  let inGithubDotComBlock = false;
  let githubDotComIndent = -1;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (inGithubDotComBlock) {
      if (indent <= githubDotComIndent) {
        inGithubDotComBlock = false;
        githubDotComIndent = -1;
      } else {
        const tokenMatch = line.match(/^\s*oauth_token:\s*(.+?)\s*$/);
        if (tokenMatch) return stripOptionalYamlQuotes(tokenMatch[1]!);
        continue;
      }
    }

    const sectionMatch = line.match(/^(\s*)(['"]?)([^'"]+)\2:\s*$/);
    if (!sectionMatch) continue;

    inGithubDotComBlock = sectionMatch[3]!.trim() === 'github.com';
    githubDotComIndent = inGithubDotComBlock ? indent : -1;
  }

  return null;
}

function stripOptionalYamlQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function asUnknownMap(value: unknown) {
  return asRecord(value) ?? {};
}

function asNestedRecordMap(value: unknown) {
  const record = asRecord(value);
  if (!record) return {};

  return Object.fromEntries(
    Object.entries(record).filter(([, entry]) => asRecord(entry) != null)
  ) as Record<string, Record<string, unknown>>;
}

function toUtcMidnightDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : '';
}
