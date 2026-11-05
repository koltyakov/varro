import { describe, expect, it } from 'vitest';
import type { ProviderLimitStatus, ProviderLimitWindow } from './protocol';
import { formatProviderLimitStatusBar } from './provider-limit-summary';

function window(id: string, percent: number | null): ProviderLimitWindow {
  return { id, label: id, unit: 'messages', remaining: 50, limit: 100, resetAt: null, percent };
}

describe('status-bar provider limits', () => {
  it('orders periods and formats remaining percentages', () => {
    expect(
      formatProviderLimitStatusBar({
        providerID: 'openai',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [window('weekly', 22), window('five_hour', 50)],
      })
    ).toBe('5h 50%, w 78%');
  });

  it('computes percentages from amounts and clamps explicit percentages', () => {
    expect(
      formatProviderLimitStatusBar({
        providerID: 'openai',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [window('five_hour', null), window('weekly', 120), window('monthly', -5)],
      })
    ).toBe('5h 50%, w 0%, m 100%');
  });

  it('does not invent percentages for windows without a total', () => {
    expect(
      formatProviderLimitStatusBar({
        providerID: 'custom',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [{ ...window('Credits', null), unit: 'credits', limit: null }],
      })
    ).toBe('Credits 50 credits');
  });

  it.each(['error', 'unsupported'] as const)('handles %s limits', (status) => {
    const limit: ProviderLimitStatus = {
      providerID: 'custom',
      status,
      source: 'provider',
      checkedAt: 1,
      note: 'No quota data',
    };
    expect(formatProviderLimitStatusBar(limit)).toBe('');
  });

  it('omits available statuses without limit windows', () => {
    expect(
      formatProviderLimitStatusBar({
        providerID: 'custom',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [],
      })
    ).toBe('');
  });
});
