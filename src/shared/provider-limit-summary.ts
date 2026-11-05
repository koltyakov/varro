import type { ProviderLimitStatus, ProviderLimitWindow } from './protocol';

export function getProviderLimitWindowPeriodLabel(window: ProviderLimitWindow) {
  const id = window.id.toLowerCase();
  const label = window.label.toLowerCase();
  if (id.includes('month') || label.includes('month')) return 'M';
  if (id.includes('week') || id.includes('seven_day') || label.includes('week')) return 'W';
  if (
    id.includes('five_hour') ||
    id === 'current-session' ||
    label.includes('5-hour') ||
    label.includes('5 hour') ||
    label === 'current session'
  )
    return '5h';
  if (
    id.includes('day') ||
    id.includes('daily') ||
    label.includes('day') ||
    label.includes('daily') ||
    id === 'requests'
  )
    return 'D';
  return '';
}

export function getProviderLimitWindowUsedPercent(window: ProviderLimitWindow): number | null {
  if (window.percent != null && Number.isFinite(window.percent)) return window.percent;
  if (window.limit == null || window.limit <= 0) return null;
  return (1 - window.remaining / window.limit) * 100;
}

export function formatProviderLimitStatusBar(status: ProviderLimitStatus): string {
  if (status.status !== 'available') return '';
  const periods = ['5h', 'D', 'W', 'M'];
  const windows = status.windows.toSorted((a, b) => {
    const aIndex = periods.indexOf(getProviderLimitWindowPeriodLabel(a));
    const bIndex = periods.indexOf(getProviderLimitWindowPeriodLabel(b));
    return (aIndex < 0 ? periods.length : aIndex) - (bIndex < 0 ? periods.length : bIndex);
  });
  return windows
    .map((window) => {
      const label = getProviderLimitWindowPeriodLabel(window).toLowerCase() || window.label;
      const used = getProviderLimitWindowUsedPercent(window);
      const value =
        used === null
          ? `${window.remaining.toLocaleString()} ${window.unit === 'unknown' ? 'left' : window.unit}`
          : `${Math.round(Math.max(0, Math.min(100, 100 - used)))}%`;
      return `${label} ${value}`;
    })
    .join(', ');
}
