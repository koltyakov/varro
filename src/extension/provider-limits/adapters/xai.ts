/* oxlint-disable anti-slop/no-unknown-parameters -- xAI billing payloads are decoded before quota extraction. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: API JSON remains opaque until adapter validation. */
import type { ProviderLimitWindow } from '../../../shared/protocol';
import { parseRateLimitResetAt } from '../../util/provider-limit';
import type { ProviderLimitAdapter, ProviderLimitAdapterContext } from '../types';
import {
  asRecord,
  clampPercent,
  getString,
  parseFiniteNumber,
  readBoundedResponseJson,
  unsupportedProviderStatus,
} from '../adapter-utils';

const XAI_BILLING_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const XAI_MONTHLY_BILLING_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/billing';
const XAI_CREDITS_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const XAI_OAUTH_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_EXPIRY_BUFFER_MS = 5 * 60_000;
const EMPTY_GRPC_FRAME = new Uint8Array(5);

export function createXaiAdapter(): ProviderLimitAdapter {
  return {
    id: 'xai',
    capabilities: { oauthRefresh: true },
    matches(provider, authStore) {
      return provider.id === 'xai' && authStore.xai?.type === 'oauth';
    },
    async fetch({
      provider,
      authStore,
      modelID,
      checkedAt,
      setProviderAuth,
    }: ProviderLimitAdapterContext) {
      const auth = authStore.xai;
      if (auth?.type !== 'oauth') {
        return unsupportedProviderStatus(
          provider.id,
          modelID,
          checkedAt,
          'No SuperGrok credentials available'
        );
      }

      try {
        let accessToken = auth.access;
        let refreshed = false;
        const refreshAccessToken = async () => {
          if (!auth.refresh || !setProviderAuth) return false;
          const next = await refreshXaiAccessToken(auth.refresh);
          await setProviderAuth(provider.id, {
            type: 'oauth',
            access: next.accessToken,
            refresh: next.refreshToken,
            expires: next.expires,
          });
          accessToken = next.accessToken;
          refreshed = true;
          return true;
        };
        if (
          auth.refresh &&
          auth.expires != null &&
          auth.expires <= Date.now() + XAI_OAUTH_EXPIRY_BUFFER_MS
        ) {
          await refreshAccessToken();
        }

        const request = (url: string) =>
          fetch(url, {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${accessToken}`,
              'x-xai-token-auth': 'xai-grok-cli',
              'User-Agent': 'Varro/0.1.0',
            },
            signal: AbortSignal.timeout(10_000),
          });
        let response = await request(XAI_BILLING_ENDPOINT);

        if ((response.status === 401 || response.status === 403) && !refreshed) {
          if (await refreshAccessToken()) response = await request(XAI_BILLING_ENDPOINT);
        }

        if (response.status === 401 || response.status === 403) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            `SuperGrok billing endpoint rejected credentials (${response.status})`
          );
        }

        if (!response.ok) {
          return {
            providerID: provider.id,
            modelID,
            status: 'error',
            source: 'provider',
            checkedAt,
            note: `SuperGrok billing endpoint returned ${response.status}`,
          };
        }

        const windows = extractXaiBillingWindows(
          await readBoundedResponseJson(response),
          checkedAt
        );
        if (!windows.some((window) => window.id === 'credits')) {
          const monthlyResponse = await request(XAI_MONTHLY_BILLING_ENDPOINT);
          if (monthlyResponse.status === 401 || monthlyResponse.status === 403) {
            return unsupportedProviderStatus(
              provider.id,
              modelID,
              checkedAt,
              `SuperGrok billing endpoint rejected credentials (${monthlyResponse.status})`
            );
          }
          if (!monthlyResponse.ok && windows.length === 0) {
            return {
              providerID: provider.id,
              modelID,
              status: 'error',
              source: 'provider',
              checkedAt,
              note: `SuperGrok billing endpoint returned ${monthlyResponse.status}`,
            };
          }
          if (monthlyResponse.ok) {
            const monthlyWindows = extractXaiBillingWindows(
              (await monthlyResponse.json()) as unknown,
              checkedAt
            );
            const existing = new Set(windows.map((window) => window.id));
            windows.push(...monthlyWindows.filter((window) => !existing.has(window.id)));
          }
        }
        if (windows.length === 0) {
          const creditsResponse = await fetch(XAI_CREDITS_ENDPOINT, {
            method: 'POST',
            headers: {
              Accept: '*/*',
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/grpc-web+proto',
              Origin: 'https://grok.com',
              Referer: 'https://grok.com/?_s=usage',
              'User-Agent': 'Varro/0.1.0',
              'x-grpc-web': '1',
              'x-user-agent': 'connect-es/2.1.1',
            },
            body: EMPTY_GRPC_FRAME,
            signal: AbortSignal.timeout(10_000),
          });
          if (creditsResponse.status === 401 || creditsResponse.status === 403) {
            return unsupportedProviderStatus(
              provider.id,
              modelID,
              checkedAt,
              `SuperGrok credits endpoint rejected credentials (${creditsResponse.status})`
            );
          }
          if (creditsResponse.ok) {
            const parsed = parseXaiCreditsResponse(
              new Uint8Array(await creditsResponse.arrayBuffer()),
              checkedAt
            );
            if (parsed.grpcStatus === 7 || parsed.grpcStatus === 16) {
              return unsupportedProviderStatus(
                provider.id,
                modelID,
                checkedAt,
                `SuperGrok credits endpoint rejected credentials (gRPC ${parsed.grpcStatus})`
              );
            }
            if (parsed.resetAt != null) {
              const percent = parsed.percent ?? 0;
              windows.push({
                id: 'credits',
                label: getResetWindowLabel(parsed.resetAt, checkedAt),
                unit: 'credits',
                remaining: Math.max(0, 100 - percent),
                limit: 100,
                resetAt: parsed.resetAt,
                percent,
              });
            }
          }
        }
        if (windows.length === 0) {
          return unsupportedProviderStatus(
            provider.id,
            modelID,
            checkedAt,
            'SuperGrok billing endpoint did not expose a bounded quota'
          );
        }

        return {
          providerID: provider.id,
          modelID,
          status: 'available',
          source: 'provider',
          checkedAt,
          windows,
          planName: 'SuperGrok',
          note: 'Polled SuperGrok billing endpoint',
        };
      } catch {
        return {
          providerID: provider.id,
          modelID,
          status: 'error',
          source: 'provider',
          checkedAt,
          note: 'Failed to poll the SuperGrok billing endpoint',
        };
      }
    },
  };
}

async function refreshXaiAccessToken(refreshToken: string) {
  const response = await fetch(XAI_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: XAI_OAUTH_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`xAI OAuth token refresh returned ${response.status}`);

  const payload = asRecord(await readBoundedResponseJson(response));
  const accessToken = getString(payload?.access_token);
  if (!accessToken) throw new Error('xAI OAuth token refresh did not return an access token');
  const expiresIn = parseFiniteNumber(payload?.expires_in) ?? 3600;
  return {
    accessToken,
    refreshToken: getString(payload?.refresh_token) || refreshToken,
    expires: Date.now() + Math.max(0, expiresIn) * 1000,
  };
}

function extractXaiBillingWindows(payload: unknown, checkedAt: number): ProviderLimitWindow[] {
  const root = asRecord(payload);
  const config = asRecord(root?.config) ?? root;
  if (!config) return [];

  const windows: ProviderLimitWindow[] = [];
  const usedPercent = clampPercent(parseFiniteNumber(config.creditUsagePercent));
  const currentPeriod = asRecord(config.currentPeriod);
  if (usedPercent != null) {
    windows.push({
      id: 'credits',
      label: getPeriodLabel(getString(currentPeriod?.type)),
      unit: 'credits',
      remaining: Math.max(0, 100 - usedPercent),
      limit: 100,
      resetAt: parseRateLimitResetAt(currentPeriod?.end ?? config.billingPeriodEnd, checkedAt),
      percent: usedPercent,
    });
  }

  const onDemandCap = parseAmount(config.onDemandCap);
  const onDemandUsed = parseAmount(config.onDemandUsed);
  if (onDemandCap != null && onDemandCap > 0 && onDemandUsed != null) {
    windows.push({
      id: 'on_demand',
      label: 'On-demand Credits',
      unit: 'credits',
      remaining: Math.max(0, onDemandCap - onDemandUsed),
      limit: onDemandCap,
      resetAt: parseRateLimitResetAt(config.billingPeriodEnd, checkedAt),
      percent: clampPercent((onDemandUsed / onDemandCap) * 100),
    });
  }

  if (windows.length > 0) return windows;

  const usage = asRecord(root?.usage) ?? asRecord(config.usage);
  const monthlyLimit = parseAmount(root?.monthlyLimit ?? config.monthlyLimit);
  const monthlyUsed = parseAmount(usage?.totalUsed ?? config.used);
  if (monthlyLimit == null || monthlyLimit <= 0 || monthlyUsed == null) return [];

  return [
    {
      id: 'monthly_credits',
      label: 'Monthly Credits',
      unit: 'credits',
      remaining: Math.max(0, monthlyLimit - monthlyUsed),
      limit: monthlyLimit,
      resetAt: parseRateLimitResetAt(
        asRecord(root?.billingCycle)?.billingPeriodEnd ?? config.billingPeriodEnd,
        checkedAt
      ),
      percent: clampPercent((monthlyUsed / monthlyLimit) * 100),
    },
  ];
}

function parseAmount(value: unknown) {
  return parseFiniteNumber(asRecord(value)?.val ?? value);
}

function getPeriodLabel(periodType: string) {
  const normalized = periodType.toUpperCase();
  if (normalized.includes('WEEKLY')) return 'Weekly Credits';
  if (normalized.includes('MONTHLY')) return 'Monthly Credits';
  if (normalized.includes('DAILY')) return 'Daily Credits';
  return 'Credits';
}

function parseXaiCreditsResponse(bytes: Uint8Array, checkedAt: number) {
  const payloads: Uint8Array[] = [];
  let grpcStatus: number | null = null;
  for (let index = 0; index + 5 <= bytes.length;) {
    const flags = bytes[index] ?? 0;
    const length = new DataView(bytes.buffer, bytes.byteOffset + index + 1, 4).getUint32(0);
    const start = index + 5;
    const end = Math.min(bytes.length, start + length);
    const frame = bytes.subarray(start, end);
    if ((flags & 0x80) === 0) {
      payloads.push(frame);
    } else {
      const match = new TextDecoder().decode(frame).match(/(?:^|\r?\n)grpc-status:\s*(\d+)/i);
      if (match?.[1]) grpcStatus = Number.parseInt(match[1], 10);
    }
    index = end;
  }

  const percents: Array<{ value: number; depth: number; field: number }> = [];
  const resets: Array<{ value: number; path: string }> = [];
  const payload = Uint8Array.from(payloads.flatMap((part) => [...part]));
  scanXaiCreditsPayload(payload, [], percents, resets, checkedAt);
  percents.sort((left, right) => {
    const leftPreferred = left.field === 1 ? 0 : 1;
    const rightPreferred = right.field === 1 ? 0 : 1;
    return leftPreferred - rightPreferred || left.depth - right.depth;
  });
  const preferredReset = resets.find((reset) => reset.path === '1.5.1');
  resets.sort((left, right) => left.value - right.value);

  return {
    percent: clampPercent(percents[0]?.value ?? null),
    resetAt: preferredReset?.value ?? resets[0]?.value ?? null,
    grpcStatus,
  };
}

function scanXaiCreditsPayload(
  bytes: Uint8Array,
  path: number[],
  percents: Array<{ value: number; depth: number; field: number }>,
  resets: Array<{ value: number; path: string }>,
  checkedAt: number
) {
  if (path.length > 8) return;
  for (let index = 0; index < bytes.length;) {
    const [tag, next] = readVarint(bytes, index);
    index = next;
    const field = tag >>> 3;
    if (field === 0) return;
    const wire = tag & 7;
    const nextPath = [...path, field];
    if (wire === 0) {
      const [value, end] = readVarint(bytes, index);
      index = end;
      if (value >= 1_700_000_000 && value <= 2_100_000_000 && value * 1000 > checkedAt) {
        resets.push({ value: value * 1000, path: nextPath.join('.') });
      }
    } else if (wire === 1 && index + 8 <= bytes.length) {
      const value = new DataView(bytes.buffer, bytes.byteOffset + index, 8).getFloat64(0, true);
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        percents.push({ value, depth: nextPath.length, field });
      }
      index += 8;
    } else if (wire === 2) {
      const [length, end] = readVarint(bytes, index);
      const finish = Math.min(bytes.length, end + length);
      scanXaiCreditsPayload(bytes.subarray(end, finish), nextPath, percents, resets, checkedAt);
      index = finish;
    } else if (wire === 5 && index + 4 <= bytes.length) {
      const value = new DataView(bytes.buffer, bytes.byteOffset + index, 4).getFloat32(0, true);
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        percents.push({ value, depth: nextPath.length, field });
      }
      index += 4;
    } else {
      return;
    }
  }
}

function readVarint(bytes: Uint8Array, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 49) return [0, bytes.length];
  }
  return [value, index];
}

function getResetWindowLabel(resetAt: number, checkedAt: number) {
  const days = (resetAt - checkedAt) / 86_400_000;
  if (days >= 4 && days <= 12) return 'Weekly Credits';
  if (days >= 20 && days <= 45) return 'Monthly Credits';
  return 'Credits';
}
