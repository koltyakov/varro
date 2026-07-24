import { describe, expect, it } from 'vitest';
import { clampPercent, parseFiniteNumber, toLabel } from './adapter-utils';

describe('parseFiniteNumber', () => {
  it('passes through finite numbers', () => {
    expect(parseFiniteNumber(42)).toBe(42);
    expect(parseFiniteNumber(0)).toBe(0);
    expect(parseFiniteNumber(-1.5)).toBe(-1.5);
  });

  it('rejects non-finite numbers and non-numeric input', () => {
    expect(parseFiniteNumber(Number.NaN)).toBeNull();
    expect(parseFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseFiniteNumber(null)).toBeNull();
    expect(parseFiniteNumber({})).toBeNull();
    expect(parseFiniteNumber('  ')).toBeNull();
    expect(parseFiniteNumber('abc')).toBeNull();
  });

  it('parses plain numeric strings', () => {
    expect(parseFiniteNumber(' 42 ')).toBe(42);
    expect(parseFiniteNumber('1.5')).toBe(1.5);
    expect(parseFiniteNumber('-2')).toBe(-2);
  });

  it('strips thousands separators', () => {
    expect(parseFiniteNumber('1,234')).toBe(1234);
    expect(parseFiniteNumber('1,234,567')).toBe(1234567);
    expect(parseFiniteNumber('1,234.56')).toBe(1234.56);
  });

  it('refuses ambiguous decimal commas instead of inflating them', () => {
    // Stripping every comma would read "1,5" as 15.
    expect(parseFiniteNumber('1,5')).toBeNull();
    expect(parseFiniteNumber('0,25')).toBeNull();
  });
});

describe('clampPercent', () => {
  it('clamps into range and rounds', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(12.34567)).toBe(12.346);
  });

  it('returns null for missing or non-finite values', () => {
    expect(clampPercent(null)).toBeNull();
    expect(clampPercent(Number.NaN)).toBeNull();
  });
});

describe('toLabel', () => {
  it('humanizes separator-delimited names', () => {
    expect(toLabel('five_hour_window')).toBe('Five Hour Window');
    expect(toLabel('weekly-limit')).toBe('Weekly Limit');
  });

  it('falls back for empty input', () => {
    expect(toLabel('')).toBe('Limit');
  });
});
