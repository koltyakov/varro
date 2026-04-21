import { describe, expect, it } from 'vitest';
import {
  formatAgentInitial,
  formatAgentLabel,
  formatContextLimit,
  formatLabelWithProvider,
  formatProviderLimitCompact,
  formatProviderLimitTitle,
  formatVariantInitial,
  formatVariantLabel,
  getProviderLimitTone,
  getPrimaryProviderLimitWindow,
} from './format';

function availableLimit(
  windows: Array<{
    id: string;
    label: string;
    unit: 'requests' | 'tokens' | 'messages' | 'credits' | 'unknown';
    remaining: number;
    limit: number | null;
    resetAt: number | null;
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

  it('appends provider names in parentheses', () => {
    expect(formatLabelWithProvider('GPT-5.4', 'OpenAI')).toBe('GPT-5.4 (OpenAI)');
    expect(formatLabelWithProvider('GPT-5.4 · High', 'Anthropic')).toBe('GPT-5.4 · High (Anthropic)');
    expect(formatLabelWithProvider('Thinking', '')).toBe('Thinking');
    expect(formatLabelWithProvider('  Thinking  ', '  OpenAI  ')).toBe('Thinking (OpenAI)');
    expect(formatLabelWithProvider('   ', 'OpenAI')).toBe('');
  });

  it('selects the most constrained provider limit window', () => {
    const limit = availableLimit([
      { id: 'requests', label: 'Requests', unit: 'requests', remaining: 40, limit: 100, resetAt: 60_000 },
      { id: 'tokens', label: 'Tokens', unit: 'tokens', remaining: 12_000, limit: 20_000, resetAt: 90_000 },
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
      { id: 'messages', label: 'Messages', unit: 'messages', remaining: 5, limit: 10, resetAt: null },
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
      { id: 'requests', label: 'Requests', unit: 'requests', remaining: 12, limit: 50, resetAt: 120_000 },
    ]);

    expect(formatProviderLimitCompact(limit)).toBe('12 req');
    expect(formatProviderLimitTitle(limit, 60_000)).toBe('Requests: 12 / 50 left, resets in 1m');
  });

  it('formats compact provider badges for each supported unit and fallback', () => {
    expect(
      formatProviderLimitCompact(
        availableLimit([
          { id: 'tokens', label: 'Tokens', unit: 'tokens', remaining: 1_200, limit: 2_000, resetAt: null },
        ])
      )
    ).toBe('1k tok');

    expect(
      formatProviderLimitCompact(
        availableLimit([
          { id: 'messages', label: 'Messages', unit: 'messages', remaining: 9.4, limit: 10, resetAt: null },
        ])
      )
    ).toBe('9.4 msg');

    expect(
      formatProviderLimitCompact(
        availableLimit([
          { id: 'credits', label: 'Credits', unit: 'credits', remaining: 12_000_000, limit: null, resetAt: null },
        ])
      )
    ).toBe('12M cr');

    expect(
      formatProviderLimitCompact(
        availableLimit([
          { id: 'custom', label: 'Custom', unit: 'unknown', remaining: 0.5, limit: null, resetAt: null },
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
          { id: 'requests', label: 'Requests', unit: 'requests', remaining: 20, limit: 100, resetAt: null },
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
          { id: 'requests', label: 'Requests', unit: 'requests', remaining: 5, limit: 100, resetAt: null },
        ],
      })
    ).toBe('error');
  });

  it('uses a default tone when there is no meaningful limit ratio', () => {
    expect(getProviderLimitTone(null)).toBe('default');
    expect(
      getProviderLimitTone(
        availableLimit([
          { id: 'requests', label: 'Requests', unit: 'requests', remaining: 80, limit: 100, resetAt: null },
        ])
      )
    ).toBe('default');
    expect(
      getProviderLimitTone(
        availableLimit([
          { id: 'requests', label: 'Requests', unit: 'requests', remaining: 80, limit: null, resetAt: null },
        ])
      )
    ).toBe('default');
    expect(
      getProviderLimitTone(
        availableLimit([
          { id: 'requests', label: 'Requests', unit: 'requests', remaining: 80, limit: 0, resetAt: null },
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
      { id: 'seconds', label: 'Seconds', unit: 'requests', remaining: 2, limit: null, resetAt: 20_000 },
      { id: 'hours', label: 'Hours', unit: 'requests', remaining: 3, limit: 3_000, resetAt: 3_600_000 },
      { id: 'days', label: 'Days', unit: 'requests', remaining: 4, limit: 40, resetAt: 72 * 3_600_000 },
    ]);

    expect(formatProviderLimitTitle(limit, 0)).toBe(
      'Subsec: 1 / 10 left, resets in <1s | Seconds: 2 left, resets in 20s | Hours: 3 / 3k left, resets in 1h | Days: 4 / 40 left, resets in 3d'
    );
  });
});
