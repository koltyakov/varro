import { describe, expect, it } from 'vitest';
import { formatClockTime, formatMessageSentTime } from './message-time';

describe('formatMessageSentTime', () => {
  const now = new Date(2026, 8, 16, 12);

  it('keeps the local clock time for today', () => {
    const sent = new Date(2026, 8, 16, 9, 30).getTime();
    expect(formatMessageSentTime(sent, now)).toBe(formatClockTime(sent));
  });

  it.each([
    [1, '1 day ago'],
    [6, '6 days ago'],
    [7, '1 week ago'],
    [14, '2 weeks ago'],
    [30, '1 month ago'],
    [60, '2 months ago'],
    [365, '1 year ago'],
    [730, '2 years ago'],
  ])('formats %i calendar days ago as %s', (days, expected) => {
    const sent = new Date(2026, 8, 16 - days, 13, 45);
    expect(formatMessageSentTime(sent.getTime(), now)).toBe(expected);
  });

  it('counts yesterday across midnight even when less than a day elapsed', () => {
    expect(
      formatMessageSentTime(new Date(2026, 2, 8, 23, 59).getTime(), new Date(2026, 2, 9, 0, 1))
    ).toBe('1 day ago');
  });
});
