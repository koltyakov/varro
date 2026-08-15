export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/** Turn summaries stay at second granularity; sub-second work reads "<1s". */
export function formatTurnDuration(ms: number | undefined): string {
  if (!ms || ms < 1000) return '<1s';
  return formatDuration(ms);
}

export function formatRelativeAge(timestamp: number, now: number): string {
  const totalMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));

  if (totalMinutes < 1) return 'now';

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor(totalMinutes / 60);

  if (days >= 7) return `${Math.floor(days / 7)}w`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${totalMinutes}m`;
}

export function formatRelativeReset(resetAt: number, now: number): string {
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
