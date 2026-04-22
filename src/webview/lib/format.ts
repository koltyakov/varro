import type { ProviderLimitStatus, ProviderLimitWindow } from '../../shared/protocol';

export function formatVariantLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

export function formatVariantInitial(variant: string) {
  const label = formatVariantLabel(variant).trim();
  return label ? label[0] : '';
}

export function formatAgentLabel(agent: string | null | undefined) {
  if (!agent) return '';
  return agent[0].toUpperCase() + agent.slice(1);
}

export function formatAgentInitial(agent: string | null | undefined) {
  const label = formatAgentLabel(agent).trim();
  return label ? label[0] : '';
}

export function formatContextLimit(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function formatLabelWithProvider(
  label: string | null | undefined,
  provider: string | null | undefined
) {
  const base = label?.trim();
  if (!base) return '';
  const providerName = provider?.trim();
  if (!providerName) return base;
  return `${base} (${providerName})`;
}

export function getPrimaryProviderLimitWindow(limit: ProviderLimitStatus | null | undefined) {
  if (!limit || limit.status !== 'available' || limit.windows.length === 0) return null;

  return [...limit.windows].sort((a, b) => compareProviderLimitWindows(a, b))[0] ?? null;
}

export function getProviderLimitTone(limit: ProviderLimitStatus | null | undefined) {
  const window = getPrimaryProviderLimitWindow(limit);
  if (!window || window.limit == null || window.limit <= 0) return 'default';

  const ratio = window.remaining / window.limit;
  if (ratio <= 0.1) return 'error';
  if (ratio <= 0.25) return 'warning';
  return 'default';
}

export function formatProviderLimitCompact(limit: ProviderLimitStatus | null | undefined) {
  const window = getPrimaryProviderLimitWindow(limit);
  if (!window) return '';

  const suffix =
    window.unit === 'requests'
      ? 'req'
      : window.unit === 'tokens'
        ? 'tok'
        : window.unit === 'messages'
          ? 'msg'
          : window.unit === 'credits'
            ? 'cr'
            : 'left';

  return suffix === 'left'
    ? `${formatCompactValue(window.remaining)} left`
    : `${formatCompactValue(window.remaining)} ${suffix}`;
}

export function formatProviderLimitTitle(
  limit: ProviderLimitStatus | null | undefined,
  now = Date.now()
) {
  if (!limit) return '';
  if (limit.status !== 'available') return limit.note;

  return limit.windows
    .map((window) => {
      const total = window.limit != null ? ` / ${formatCompactValue(window.limit)}` : '';
      const reset = window.resetAt ? `, resets in ${formatRelativeReset(window.resetAt, now)}` : '';
      return `${window.label}: ${formatCompactValue(window.remaining)}${total} left${reset}`;
    })
    .join(' | ');
}

function compareProviderLimitWindows(a: ProviderLimitWindow, b: ProviderLimitWindow) {
  const aRatio = getWindowRatio(a);
  const bRatio = getWindowRatio(b);
  if (aRatio !== bRatio) return aRatio - bRatio;
  return getWindowPriority(a) - getWindowPriority(b);
}

function getWindowRatio(window: ProviderLimitWindow) {
  if (window.limit == null || window.limit <= 0) return Number.POSITIVE_INFINITY;
  return window.remaining / window.limit;
}

function getWindowPriority(window: ProviderLimitWindow) {
  if (window.unit === 'messages') return 0;
  if (window.unit === 'requests') return 1;
  if (window.unit === 'credits') return 2;
  if (window.unit === 'tokens') return 3;
  return 4;
}

function formatCompactValue(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  if (Number.isInteger(value) || value >= 10) return `${Math.round(value)}`;
  return value.toFixed(1).replace(/\.0$/, '');
}

function formatRelativeReset(resetAt: number, now: number) {
  const remainingMs = Math.max(resetAt - now, 0);
  if (remainingMs < 1000) return '<1s';

  const totalSeconds = Math.round(remainingMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h`;

  return `${Math.round(totalHours / 24)}d`;
}
