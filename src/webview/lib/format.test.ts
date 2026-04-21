import { describe, expect, it } from 'vitest';
import {
  formatAgentInitial,
  formatAgentLabel,
  formatContextLimit,
  formatVariantInitial,
  formatVariantLabel,
} from './format';

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
  });

  it('formats context limits at each threshold', () => {
    expect(formatContextLimit(999)).toBe('999');
    expect(formatContextLimit(1_499)).toBe('1k');
    expect(formatContextLimit(1_500)).toBe('2k');
    expect(formatContextLimit(1_000_000)).toBe('1.0M');
    expect(formatContextLimit(12_000_000)).toBe('12M');
  });
});
