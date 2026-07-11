import type { Session } from '../types';

function getUpdateAgeBucket(timestamp: number, now: number): number {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return minutes;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 60 + hours;

  const days = Math.floor(hours / 24);
  if (days < 7) return 84 + days;

  return 91 + Math.floor(days / 7);
}

export function compareSessionsByActivity(
  left: Pick<Session, 'time'>,
  right: Pick<Session, 'time'>,
  now: number
): number {
  const activityOrder =
    getUpdateAgeBucket(left.time.updated, now) - getUpdateAgeBucket(right.time.updated, now);
  return activityOrder || right.time.created - left.time.created;
}
