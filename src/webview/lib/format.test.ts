import { describe, expect, it } from 'vitest';
import {
  formatAgentInitial,
  formatAgentLabel,
  formatContextLimit,
  formatEditCount,
  formatLabelWithProvider,
  formatModelName,
  formatModelReleaseDate,
  formatProviderLimitCompact,
  formatProviderLimitCompactPrefix,
  formatProviderLimitTitle,
  formatVariantInitial,
  formatVariantLabel,
  getProviderLimitCompactBadges,
  hasProviderLimitWindowWithinThreshold,
  getProviderLimitTone,
  getOrderedProviderLimitWindows,
  getPrimaryProviderLimitWindow,
  resolveProviderLimitWindow,
} from './format';

function availableLimit(
  windows: Array<{
    id: string;
    label: string;
    unit: 'requests' | 'tokens' | 'messages' | 'credits' | 'usd' | 'unknown';
    remaining: number;
    limit: number | null;
    resetAt: number | null;
    percent?: number | null;
  }>
) {
  return {
    providerID: 'provider-1',
    modelID: 'model-1',
    status: 'available' as const,
    source: 'provider' as const,
    checkedAt: 0,
    windows,
  };
}

describe('format helpers', () => {
  it('formats variant labels across separators', () => {
    expect(formatVariantLabel('high_reasoning-mode')).toBe('High Reasoning Mode');
    expect(formatVariantLabel('double__dash--value')).toBe('Double  Dash  Value');
    expect(formatVariantLabel('alreadyCaps')).toBe('AlreadyCaps');
  });

  it('derives initials from formatted values', () => {
    expect(formatVariantInitial('fast_mode')).toBe('F');
    expect(formatVariantInitial('')).toBe('');
    expect(formatAgentInitial('coder')).toBe('C');
    expect(formatAgentInitial(undefined)).toBe('');
  });

  it('formats agent labels safely', () => {
    expect(formatAgentLabel('planner')).toBe('Planner');
    expect(formatAgentLabel('')).toBe('');
    expect(formatAgentLabel(null)).toBe('');
    expect(formatAgentLabel(' agent')).toBe(' agent');
  });

  it('formats context limits at each threshold', () => {
    expect(formatContextLimit(999)).toBe('999');
    expect(formatContextLimit(1_499)).toBe('1k');
    expect(formatContextLimit(1_500)).toBe('2k');
    expect(formatContextLimit(1_000_000)).toBe('1.0M');
    expect(formatContextLimit(12_000_000)).toBe('12M');
  });

  it('replaces Fast in GPT model display names with a lightning symbol', () => {
    expect(formatModelName('GPT-5.6 Fast')).toBe('GPT-5.6 ⚡');
    expect(formatModelName('GPT-5 Fast Reasoning')).toBe('GPT-5 ⚡ Reasoning');
    expect(formatModelName('Claude Fast')).toBe('Claude Fast');
    expect(formatModelName('GPT-5 Faster')).toBe('GPT-5 Faster');
  });

  it('formats model release dates in UTC and ignores invalid values', () => {
    expect(formatModelReleaseDate('2026-01-01')).toBe('2026/01/01');
    expect(formatModelReleaseDate('2026-07-09T23:00:00-05:00')).toBe('2026/07/10');
    expect(formatModelReleaseDate('not-a-date')).toBe('');
    expect(formatModelReleaseDate(undefined)).toBe('');
  });

  it('compacts large edit counts', () => {
    expect(formatEditCount(9_999)).toBe('9999');
    expect(formatEditCount(10_000)).toBe('10K');
    expect(formatEditCount(30_098)).toBe('30K');
    expect(formatEditCount(10_000_000)).toBe('10M');
  });

  it('appends provider names in parentheses', () => {
    expect(formatLabelWithProvider('GPT-5.4', 'OpenAI')).toBe('GPT-5.4 (OpenAI)');
    expect(formatLabelWithProvider('GPT-5.4 · High', 'Anthropic')).toBe(
      'GPT-5.4 · High (Anthropic)'
    );
    expect(formatLabelWithProvider('Thinking', '')).toBe('Thinking');
    expect(formatLabelWithProvider('  Thinking  ', '  OpenAI  ')).toBe('Thinking (OpenAI)');
    expect(formatLabelWithProvider('   ', 'OpenAI')).toBe('');
  });

  it('selects the most constrained provider limit window', () => {
    const limit = availableLimit([
      {
        id: 'requests',
        label: 'Requests',
        unit: 'requests',
        remaining: 40,
        limit: 100,
        resetAt: 60_000,
      },
      {
        id: 'tokens',
        label: 'Tokens',
        unit: 'tokens',
        remaining: 12_000,
        limit: 20_000,
        resetAt: 90_000,
      },
    ]);

    expect(getPrimaryProviderLimitWindow(limit)).toEqual(limit.windows[0]);
  });

  it('falls back safely when there is no available primary provider window', () => {
    expect(getPrimaryProviderLimitWindow(null)).toBeNull();
    expect(
      getPrimaryProviderLimitWindow({
        providerID: 'provider-1',
        status: 'unsupported',
        source: 'provider',
        checkedAt: 0,
        note: 'Unavailable',
      })
    ).toBeNull();
    expect(getPrimaryProviderLimitWindow(availableLimit([]))).toBeNull();
  });

  it('breaks tied provider windows by priority', () => {
    const limit = availableLimit([
      { id: 'tokens', label: 'Tokens', unit: 'tokens', remaining: 10, limit: 20, resetAt: null },
      {
        id: 'messages',
        label: 'Messages',
        unit: 'messages',
        remaining: 5,
        limit: 10,
        resetAt: null,
      },
      { id: 'credits', label: 'Credits', unit: 'credits', remaining: 3, limit: 6, resetAt: null },
    ]);

    expect(getPrimaryProviderLimitWindow(limit)).toEqual(limit.windows[1]);
  });

  it('ranks unknown provider limit units after known ones when ratios tie', () => {
    const limit = availableLimit([
      { id: 'unknown', label: 'Unknown', unit: 'unknown', remaining: 5, limit: 10, resetAt: null },
      { id: 'tokens', label: 'Tokens', unit: 'tokens', remaining: 5, limit: 10, resetAt: null },
    ]);

    expect(getPrimaryProviderLimitWindow(limit)).toEqual(limit.windows[1]);
  });

  it('formats compact provider limit badges and tooltips', () => {
    const limit = availableLimit([
      {
        id: 'requests',
        label: 'Requests',
        unit: 'requests',
        remaining: 12,
        limit: 50,
        resetAt: 120_000,
      },
    ]);

    expect(formatProviderLimitCompactPrefix(limit)).toBe('D');
    expect(formatProviderLimitCompact(limit)).toBe('24%');
    expect(formatProviderLimitTitle(limit, 60_000)).toBe('Requests: 12 / 50 left, resets in 1m');
  });

  it('keeps a compact badge for a single unprefixed window', () => {
    const limit = availableLimit([
      {
        id: 'messages',
        label: 'Messages',
        unit: 'messages',
        remaining: 0,
        limit: 40,
        resetAt: 120_000,
      },
    ]);

    expect(formatProviderLimitCompactPrefix(limit)).toBe('');
    expect(getProviderLimitCompactBadges(limit)).toEqual([{ label: '0%', tone: 'error' }]);
    expect(formatProviderLimitTitle(limit, 60_000)).toBe('Messages: 0 / 40 left, resets in 1m');
  });

  it('omits 5h, W, and M prefixes in compact provider limit badge groups', () => {
    const limit = availableLimit([
      {
        id: 'month',
        label: 'Monthly',
        unit: 'requests',
        remaining: 40,
        limit: 100,
        resetAt: null,
        percent: 60,
      },
      {
        id: 'five_hour',
        label: '5-hour',
        unit: 'requests',
        remaining: 0,
        limit: 100,
        resetAt: null,
        percent: 100,
      },
      {
        id: 'week',
        label: 'Weekly',
        unit: 'requests',
        remaining: 12,
        limit: 100,
        resetAt: null,
        percent: 88,
      },
      {
        id: 'day',
        label: 'Daily',
        unit: 'requests',
        remaining: 8,
        limit: 100,
        resetAt: null,
        percent: 92,
      },
    ]);

    expect(getProviderLimitCompactBadges(limit)).toEqual([
      { label: '0%', tone: 'error' },
      { label: '12%', tone: 'warning' },
      { label: '40%', tone: 'default' },
    ]);
  });

  it('derives period prefixes for weekly and monthly windows', () => {
    expect(
      formatProviderLimitCompactPrefix(
        availableLimit([
          {
            id: 'seven_day',
            label: 'Weekly All-Model',
            unit: 'requests',
            remaining: 68,
            limit: 100,
            resetAt: null,
          },
        ])
      )
    ).toBe('W');

    expect(
      formatProviderLimitCompactPrefix(
        availableLimit([
          {
            id: 'monthly_limit',
            label: 'Monthly Limit',
            unit: 'credits',
            remaining: 40,
            limit: 100,
            resetAt: null,
          },
        ])
      )
    ).toBe('M');

    expect(
      formatProviderLimitCompactPrefix(
        availableLimit([
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 60,
            limit: 100,
            resetAt: null,
          },
        ])
      )
    ).toBe('5h');
  });

  it('resolves the selected window and overrides when another has lower remaining', () => {
    const limit = availableLimit([
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'requests',
        remaining: 80,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'seven_day',
        label: 'Weekly All-Model',
        unit: 'requests',
        remaining: 60,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'monthly_limit',
        label: 'Monthly Limit',
        unit: 'requests',
        remaining: 90,
        limit: 100,
        resetAt: null,
      },
    ]);

    // Selection respected when no smaller-remaining window exists.
    expect(resolveProviderLimitWindow(limit, 'seven_day')?.id).toBe('seven_day');

    // Manual selection is remembered even when another window is more constrained.
    expect(resolveProviderLimitWindow(limit, 'monthly_limit')?.id).toBe('monthly_limit');

    // No selection falls back to the narrowest period window.
    expect(resolveProviderLimitWindow(limit, null)?.id).toBe('five_hour');

    // Unknown selection falls back to the narrowest period window.
    expect(resolveProviderLimitWindow(limit, 'does_not_exist')?.id).toBe('five_hour');
  });

  it('orders provider limit windows by narrowest period first', () => {
    const limit = availableLimit([
      {
        id: 'monthly_limit',
        label: 'Monthly Limit',
        unit: 'requests',
        remaining: 1,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'seven_day',
        label: 'Weekly All-Model',
        unit: 'requests',
        remaining: 1,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'requests',
        remaining: 80,
        limit: 100,
        resetAt: null,
      },
    ]);

    expect(getOrderedProviderLimitWindows(limit).map((window) => window.id)).toEqual([
      'five_hour',
      'seven_day',
      'monthly_limit',
    ]);
  });

  it('orders Spark provider limit windows after matching general windows', () => {
    const limit = availableLimit([
      {
        id: 'spark_five_hour',
        label: '5-Hour Limit (Spark)',
        unit: 'requests',
        remaining: 5,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'requests',
        remaining: 98,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'spark_seven_day',
        label: 'Weekly Limit (Spark)',
        unit: 'requests',
        remaining: 2,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'seven_day',
        label: 'Weekly All-Model',
        unit: 'requests',
        remaining: 92,
        limit: 100,
        resetAt: null,
      },
    ]);

    expect(getOrderedProviderLimitWindows(limit).map((window) => window.id)).toEqual([
      'five_hour',
      'seven_day',
      'spark_five_hour',
      'spark_seven_day',
    ]);
  });

  it('formats compact provider badges as remaining percent across units', () => {
    expect(
      formatProviderLimitCompact(
        availableLimit([
          {
            id: 'tokens',
            label: 'Tokens',
            unit: 'tokens',
            remaining: 1_200,
            limit: 2_000,
            resetAt: null,
          },
        ])
      )
    ).toBe('60%');

    expect(
      formatProviderLimitCompact(
        availableLimit([
          {
            id: 'messages',
            label: 'Messages',
            unit: 'messages',
            remaining: 9.4,
            limit: 10,
            resetAt: null,
          },
        ])
      )
    ).toBe('94%');

    expect(
      formatProviderLimitCompact(
        availableLimit([
          {
            id: 'usd',
            label: 'USD',
            unit: 'usd',
            remaining: 12.5,
            limit: 40,
            resetAt: null,
          },
        ])
      )
    ).toBe('31%');
  });

  it('falls back to remaining count when no ratio is computable', () => {
    expect(
      formatProviderLimitCompact(
        availableLimit([
          {
            id: 'credits',
            label: 'Credits',
            unit: 'credits',
            remaining: 12_000_000,
            limit: null,
            resetAt: null,
          },
        ])
      )
    ).toBe('12M cr');

    expect(
      formatProviderLimitCompact(
        availableLimit([
          {
            id: 'custom',
            label: 'Custom',
            unit: 'unknown',
            remaining: 0.5,
            limit: null,
            resetAt: null,
          },
        ])
      )
    ).toBe('0.5 left');

    expect(formatProviderLimitCompact(null)).toBe('');
  });

  it('uses warning and error tones as remaining ratios shrink', () => {
    expect(
      getProviderLimitTone({
        providerID: 'openai',
        status: 'available',
        source: 'provider',
        checkedAt: 0,
        windows: [
          {
            id: 'requests',
            label: 'Requests',
            unit: 'requests',
            remaining: 20,
            limit: 100,
            resetAt: null,
          },
        ],
      })
    ).toBe('warning');

    expect(
      getProviderLimitTone({
        providerID: 'openai',
        status: 'available',
        source: 'provider',
        checkedAt: 0,
        windows: [
          {
            id: 'requests',
            label: 'Requests',
            unit: 'requests',
            remaining: 5,
            limit: 100,
            resetAt: null,
          },
        ],
      })
    ).toBe('error');

    expect(
      getProviderLimitTone({
        providerID: 'openai',
        status: 'available',
        source: 'provider',
        checkedAt: 0,
        windows: [
          {
            id: 'messages',
            label: 'Messages',
            unit: 'messages',
            remaining: 0,
            limit: null,
            resetAt: null,
          },
        ],
      })
    ).toBe('error');

    expect(
      getProviderLimitTone({
        providerID: 'openrouter',
        status: 'available',
        source: 'provider',
        checkedAt: 0,
        windows: [
          {
            id: 'monthly-spend',
            label: 'Monthly Spend',
            unit: 'usd',
            remaining: 8,
            limit: null,
            resetAt: null,
            percent: 92,
          },
        ],
      })
    ).toBe('error');
  });

  it('uses a default tone when there is no meaningful limit ratio', () => {
    expect(getProviderLimitTone(null)).toBe('default');
    expect(
      getProviderLimitTone(
        availableLimit([
          {
            id: 'requests',
            label: 'Requests',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ])
      )
    ).toBe('default');
    expect(
      getProviderLimitTone(
        availableLimit([
          {
            id: 'requests',
            label: 'Requests',
            unit: 'requests',
            remaining: 80,
            limit: null,
            resetAt: null,
          },
        ])
      )
    ).toBe('default');
    expect(
      getProviderLimitTone(
        availableLimit([
          {
            id: 'requests',
            label: 'Requests',
            unit: 'requests',
            remaining: 80,
            limit: 0,
            resetAt: null,
          },
        ])
      )
    ).toBe('default');
  });

  it('formats provider limit titles for notes, multiple windows, and reset thresholds', () => {
    expect(formatProviderLimitTitle(null)).toBe('');
    expect(
      formatProviderLimitTitle({
        providerID: 'provider-1',
        status: 'error',
        source: 'provider',
        checkedAt: 0,
        note: 'Rate limits unavailable',
      })
    ).toBe('Rate limits unavailable');

    const limit = availableLimit([
      { id: 'subsec', label: 'Subsec', unit: 'requests', remaining: 1, limit: 10, resetAt: 500 },
      {
        id: 'seconds',
        label: 'Seconds',
        unit: 'requests',
        remaining: 2,
        limit: null,
        resetAt: 20_000,
      },
      {
        id: 'hours',
        label: 'Hours',
        unit: 'requests',
        remaining: 3,
        limit: 3_000,
        resetAt: 3_600_000,
      },
      {
        id: 'days',
        label: 'Days',
        unit: 'requests',
        remaining: 4,
        limit: 40,
        resetAt: 72 * 3_600_000,
      },
    ]);

    expect(formatProviderLimitTitle(limit, 0)).toBe(
      'Subsec: 1 / 10 left, resets in <1s | Seconds: 2 left, resets in 20s | Hours: 3 / 3k left, resets in 1h | Days: 4 / 40 left, resets in 3d'
    );
  });

  it('uses explicit percent metadata when ranking and formatting provider limits', () => {
    const limit = availableLimit([
      {
        id: 'requests',
        label: 'Requests',
        unit: 'requests',
        remaining: 80,
        limit: null,
        resetAt: null,
        percent: 20,
      },
      {
        id: 'monthly-spend',
        label: 'Monthly Spend',
        unit: 'usd',
        remaining: 12.5,
        limit: 40,
        resetAt: 60_000,
        percent: 68.75,
      },
    ]);

    expect(getPrimaryProviderLimitWindow(limit)).toEqual(limit.windows[1]);
    expect(formatProviderLimitTitle(limit, 0)).toBe(
      'Requests: 80 left (20% used) | Monthly Spend: $12.5 / $40 left (68.8% used), resets in 1m'
    );
  });

  it('detects when any provider-limit window crosses the remaining threshold', () => {
    const limit = availableLimit([
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'requests',
        remaining: 45,
        limit: 100,
        resetAt: null,
      },
      {
        id: 'month',
        label: 'Monthly Limit',
        unit: 'requests',
        remaining: 20,
        limit: 100,
        resetAt: null,
      },
    ]);

    expect(hasProviderLimitWindowWithinThreshold(limit, 40)).toBe(true);
    expect(hasProviderLimitWindowWithinThreshold(limit, 10)).toBe(false);
    expect(hasProviderLimitWindowWithinThreshold(null, 40)).toBe(false);
  });

  it('detects exhausted provider-limit windows without percentage metadata', () => {
    const limit = availableLimit([
      {
        id: 'requests',
        label: 'Requests',
        unit: 'requests',
        remaining: 0,
        limit: null,
        resetAt: null,
      },
    ]);

    expect(hasProviderLimitWindowWithinThreshold(limit, 40)).toBe(true);
  });

  it('treats a 100 percent threshold as show any available limit', () => {
    const limit = availableLimit([
      {
        id: 'requests',
        label: 'Requests',
        unit: 'requests',
        remaining: 7,
        limit: null,
        resetAt: null,
      },
    ]);

    expect(hasProviderLimitWindowWithinThreshold(limit, 100)).toBe(true);
  });
});
