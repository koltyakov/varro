import type { ProviderLimitStatus, ProviderLimitWindow } from '../../shared/protocol';

export function formatVariantLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

export function formatVariantInitial(variant: string) {
  const label = formatVariantLabel(variant).trim();
  return label ? label[0] : '';
}

export function formatAgentLabel(agent: string | null | undefined) {
  if (!agent) return '';
  return agent[0]!.toUpperCase() + agent.slice(1);
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

  return [...limit.windows].toSorted((a, b) => compareProviderLimitWindows(a, b))[0] ?? null;
}

/**
 * Resolve which window the toolbar chip should show.
 *
 * - If `selectedId` matches an available window, prefer it.
 * - Otherwise fall back to the narrowest period window (5h, D, W, M).
 */
export function resolveProviderLimitWindow(
  limit: ProviderLimitStatus | null | undefined,
  selectedId?: string | null
): ProviderLimitWindow | null {
  if (!limit || limit.status !== 'available' || limit.windows.length === 0) return null;

  const selected = selectedId ? limit.windows.find((w) => w.id === selectedId) : null;
  return selected ?? getDefaultProviderLimitWindow(limit);
}

export function getProviderLimitTone(
  limit: ProviderLimitStatus | null | undefined,
  window?: ProviderLimitWindow | null
) {
  const target = window ?? getPrimaryProviderLimitWindow(limit);
  if (!target) return 'default';
  if (target.remaining <= 0) return 'error';
  const percent = getWindowPercent(target);
  if (percent == null) return 'default';

  if (percent >= 90) return 'error';
  if (percent >= 75) return 'warning';
  return 'default';
}

export function getProviderLimitWindowUsedPercent(
  window: ProviderLimitWindow | null | undefined
): number | null {
  if (!window) return null;
  return getWindowPercent(window);
}

export function getProviderLimitWindowRemainingPercent(
  window: ProviderLimitWindow | null | undefined
): number | null {
  const used = getProviderLimitWindowUsedPercent(window);
  if (used == null) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

export function getOrderedProviderLimitWindows(
  limit: ProviderLimitStatus | null | undefined
): ProviderLimitWindow[] {
  if (!limit || limit.status !== 'available') return [];
  return [...limit.windows].toSorted((a, b) => compareProviderLimitDisplayWindows(a, b));
}

export function hasProviderLimitWindowWithinThreshold(
  limit: ProviderLimitStatus | null | undefined,
  thresholdPercent: number
) {
  if (!limit || limit.status !== 'available') return false;
  if (thresholdPercent >= 100 && limit.windows.length > 0) return true;

  for (const window of limit.windows) {
    if (window.remaining <= 0) return true;
    const remaining = getProviderLimitWindowRemainingPercent(window);
    if (remaining != null && remaining <= thresholdPercent) return true;
  }

  return false;
}

export function formatProviderLimitWindowValue(window: ProviderLimitWindow, value: number) {
  return formatWindowValue(window, value);
}

export function formatProviderLimitWindowReset(resetAt: number, now = Date.now()) {
  return formatRelativeReset(resetAt, now);
}

export function formatProviderLimitCompact(
  limit: ProviderLimitStatus | null | undefined,
  window?: ProviderLimitWindow | null
) {
  const target = window ?? getPrimaryProviderLimitWindow(limit);
  if (!target) return '';

  const remainingPercent = getProviderLimitWindowRemainingPercent(target);
  if (remainingPercent != null) return `${formatRemainingPercent(remainingPercent)}%`;

  const suffix =
    target.unit === 'requests'
      ? 'req'
      : target.unit === 'tokens'
        ? 'tok'
        : target.unit === 'messages'
          ? 'msg'
          : target.unit === 'credits'
            ? 'cr'
            : target.unit === 'usd'
              ? '$'
              : 'left';

  if (suffix === '$') return `$${formatCompactValue(target.remaining, 'usd')}`;

  return suffix === 'left'
    ? `${formatCompactValue(target.remaining)} left`
    : `${formatCompactValue(target.remaining)} ${suffix}`;
}

export function formatProviderLimitCompactPrefix(
  limit: ProviderLimitStatus | null | undefined,
  window?: ProviderLimitWindow | null
) {
  const target = window ?? getPrimaryProviderLimitWindow(limit);
  if (!target) return '';
  return getProviderLimitWindowPeriodLabel(target);
}

export function getProviderLimitCompactBadges(
  limit: ProviderLimitStatus | null | undefined,
  options?: {
    preferredPeriods?: string[];
    fallbackCount?: number;
  }
) {
  if (!limit || limit.status !== 'available') return [];

  const preferredPeriods = options?.preferredPeriods ?? ['5h', 'W', 'M'];
  const fallbackCount = options?.fallbackCount ?? 1;
  const windows = getOrderedProviderLimitWindows(limit);
  const preferred = windows.filter((window) => {
    const prefix = formatProviderLimitCompactPrefix(limit, window);
    return preferredPeriods.includes(prefix);
  });
  const visible =
    preferred.length > 0
      ? preferred
      : windows
          .filter((window) => {
            const value = formatProviderLimitCompact(limit, window);
            if (!value) return false;
            const prefix = formatProviderLimitCompactPrefix(limit, window);
            return !!prefix || windows.length === 1;
          })
          .slice(0, fallbackCount);

  return visible.flatMap((window) => {
    const value = formatProviderLimitCompact(limit, window);
    if (!value) return [];
    const prefix = formatProviderLimitCompactPrefix(limit, window);
    return [
      {
        label: prefix === 'D' ? `${prefix} ${value}` : value,
        tone: getProviderLimitTone(limit, window),
      },
    ];
  });
}

function formatRemainingPercent(value: number) {
  if (value >= 10) return `${Math.round(value)}`;
  if (value <= 0) return '0';
  return value.toFixed(1).replace(/\.0$/, '');
}

export function formatProviderLimitTitle(
  limit: ProviderLimitStatus | null | undefined,
  now = Date.now()
) {
  if (!limit) return '';
  if (limit.status !== 'available') return limit.note;

  return limit.windows
    .map((window) => {
      const total = window.limit != null ? ` / ${formatWindowValue(window, window.limit)}` : '';
      const percent =
        window.percent != null && Number.isFinite(window.percent)
          ? ` (${formatPercent(window.percent)}% used)`
          : '';
      const reset = window.resetAt ? `, resets in ${formatRelativeReset(window.resetAt, now)}` : '';
      return `${window.label}: ${formatWindowValue(window, window.remaining)}${total} left${percent}${reset}`;
    })
    .join(' | ');
}

function compareProviderLimitWindows(a: ProviderLimitWindow, b: ProviderLimitWindow) {
  const aRatio = getWindowRatio(a);
  const bRatio = getWindowRatio(b);
  if (aRatio !== bRatio) return aRatio - bRatio;
  return getWindowPriority(a) - getWindowPriority(b);
}

function getDefaultProviderLimitWindow(limit: ProviderLimitStatus) {
  return getOrderedProviderLimitWindows(limit)[0] ?? null;
}

function compareProviderLimitDisplayWindows(a: ProviderLimitWindow, b: ProviderLimitWindow) {
  const aPeriod = getWindowPeriodPriority(a);
  const bPeriod = getWindowPeriodPriority(b);
  if (aPeriod !== bPeriod) return aPeriod - bPeriod;
  return compareProviderLimitWindows(a, b);
}

function getWindowPeriodPriority(window: ProviderLimitWindow) {
  const id = window.id.toLowerCase();
  const period = getProviderLimitWindowPeriodLabel(window);
  const isSpark = id.includes('spark');
  if (period === '5h') return isSpark ? 3 : 0;
  if (period === 'D') return 1;
  if (period === 'W') return isSpark ? 4 : 2;
  if (period === 'M') return 5;
  return 100;
}

function getWindowRatio(window: ProviderLimitWindow) {
  if (window.percent != null && Number.isFinite(window.percent)) {
    return 1 - window.percent / 100;
  }
  if (window.limit == null || window.limit <= 0) return Number.POSITIVE_INFINITY;
  return window.remaining / window.limit;
}

function getWindowPriority(window: ProviderLimitWindow) {
  if (window.unit === 'messages') return 0;
  if (window.unit === 'requests') return 1;
  if (window.unit === 'credits') return 2;
  if (window.unit === 'usd') return 3;
  if (window.unit === 'tokens') return 4;
  return 5;
}

function getWindowPercent(window: ProviderLimitWindow) {
  if (window.percent != null && Number.isFinite(window.percent)) return window.percent;
  if (window.limit == null || window.limit <= 0) return null;
  return (1 - window.remaining / window.limit) * 100;
}

function getProviderLimitWindowPeriodLabel(window: ProviderLimitWindow) {
  const id = window.id.toLowerCase();
  const label = window.label.toLowerCase();

  if (id.includes('month') || label.includes('month')) return 'M';
  if (id.includes('week') || id.includes('seven_day') || label.includes('week')) return 'W';
  if (id.includes('five_hour') || label.includes('5-hour') || label.includes('5 hour')) {
    return '5h';
  }
  if (
    id.includes('day') ||
    id.includes('daily') ||
    label.includes('day') ||
    label.includes('daily') ||
    id === 'requests'
  ) {
    return 'D';
  }

  return '';
}

function formatWindowValue(window: ProviderLimitWindow, value: number) {
  return window.unit === 'usd' ? `$${formatCompactValue(value, 'usd')}` : formatCompactValue(value);
}

function formatPercent(value: number) {
  if (Number.isInteger(value)) return `${value}`;
  if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatCompactValue(value: number, unit?: ProviderLimitWindow['unit']) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  if (unit === 'usd') return value.toFixed(1).replace(/\.0$/, '');
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
