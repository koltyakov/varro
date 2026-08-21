import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatLoadingElapsed,
  formatRelativeAge,
  formatRelativeReset,
  formatTurnDuration,
} from './time-format';

describe('time format helpers', () => {
  it('formats durations across thresholds', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1_500)).toBe('2s');
    expect(formatDuration(9_500)).toBe('10s');
    expect(formatDuration(15_000)).toBe('15s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(3_660_000)).toBe('1h 1m');
    expect(formatDuration(172_800_000)).toBe('2d');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('clamps sub-second turn durations to <1s', () => {
    expect(formatTurnDuration(undefined)).toBe('<1s');
    expect(formatTurnDuration(2)).toBe('<1s');
    expect(formatTurnDuration(999)).toBe('<1s');
    expect(formatTurnDuration(1_500)).toBe('2s');
    expect(formatTurnDuration(125_000)).toBe('2m 5s');
  });

  it('hides loading elapsed time under 10s and formats across thresholds', () => {
    expect(formatLoadingElapsed(0)).toBeNull();
    expect(formatLoadingElapsed(9.9)).toBeNull();
    expect(formatLoadingElapsed(10)).toBe('10s');
    expect(formatLoadingElapsed(59)).toBe('59s');
    expect(formatLoadingElapsed(60)).toBe('1m 00s');
    expect(formatLoadingElapsed(125)).toBe('2m 05s');
    expect(formatLoadingElapsed(3_600)).toBe('1h');
    expect(formatLoadingElapsed(3_960)).toBe('1h 6m');
    expect(formatLoadingElapsed(-5)).toBeNull();
  });

  it('formats relative age across all thresholds', () => {
    const now = 1_000_000_000;
    expect(formatRelativeAge(now, now)).toBe('now');
    expect(formatRelativeAge(now - 30_000, now)).toBe('now');
    expect(formatRelativeAge(now - 5 * 60_000, now)).toBe('5m');
    expect(formatRelativeAge(now - 59 * 60_000, now)).toBe('59m');
    expect(formatRelativeAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatRelativeAge(now - 23 * 3_600_000, now)).toBe('23h');
    expect(formatRelativeAge(now - 2 * 86_400_000, now)).toBe('2d');
    expect(formatRelativeAge(now - 6 * 86_400_000, now)).toBe('6d');
    expect(formatRelativeAge(now - 7 * 86_400_000, now)).toBe('1w');
    expect(formatRelativeAge(now - 14 * 86_400_000, now)).toBe('2w');
    expect(formatRelativeAge(now - 30 * 86_400_000, now)).toBe('4w');
  });

  it('clamps future timestamps to now in relative age', () => {
    const now = 1_000_000_000;
    expect(formatRelativeAge(now + 60_000, now)).toBe('now');
  });

  it('formats relative reset countdowns across tiers', () => {
    const now = 1_000_000_000;
    expect(formatRelativeReset(now, now)).toBe('<1s');
    expect(formatRelativeReset(now + 500, now)).toBe('<1s');
    expect(formatRelativeReset(now + 20_000, now)).toBe('20s');
    expect(formatRelativeReset(now + 90_000, now)).toBe('2m');
    expect(formatRelativeReset(now + 3_600_000, now)).toBe('1h');
    expect(formatRelativeReset(now + 47 * 3_600_000, now)).toBe('47h');
    expect(formatRelativeReset(now + 48 * 3_600_000, now)).toBe('2d');
    expect(formatRelativeReset(now + 72 * 3_600_000, now)).toBe('3d');
  });

  it('clamps past resets to <1s', () => {
    const now = 1_000_000_000;
    expect(formatRelativeReset(now - 60_000, now)).toBe('<1s');
  });
});
