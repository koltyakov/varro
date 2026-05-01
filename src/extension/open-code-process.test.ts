import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })) },
  workspace: {},
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { areCompactionSettingsEqual, normalizeCompactionSettings } from './open-code-process';

describe('normalizeCompactionSettings', () => {
  it('returns defaults for undefined input', () => {
    expect(normalizeCompactionSettings(undefined)).toEqual({ auto: null, reserved: null });
  });

  it('returns defaults for empty object', () => {
    expect(normalizeCompactionSettings({})).toEqual({ auto: null, reserved: null });
  });

  it('preserves boolean auto', () => {
    expect(normalizeCompactionSettings({ auto: true })).toEqual({ auto: true, reserved: null });
    expect(normalizeCompactionSettings({ auto: false })).toEqual({ auto: false, reserved: null });
  });

  it('treats truthy/falsy non-boolean auto as null', () => {
    expect(normalizeCompactionSettings({ auto: 1 as unknown as boolean })).toEqual({
      auto: null,
      reserved: null,
    });
    expect(normalizeCompactionSettings({ auto: 'yes' as unknown as boolean })).toEqual({
      auto: null,
      reserved: null,
    });
  });

  it('preserves valid non-negative integer reserved', () => {
    expect(normalizeCompactionSettings({ reserved: 0 })).toEqual({ auto: null, reserved: 0 });
    expect(normalizeCompactionSettings({ reserved: 5000 })).toEqual({
      auto: null,
      reserved: 5000,
    });
  });

  it('rejects negative reserved', () => {
    expect(normalizeCompactionSettings({ reserved: -1 })).toEqual({ auto: null, reserved: null });
  });

  it('rejects non-integer reserved', () => {
    expect(normalizeCompactionSettings({ reserved: 1.5 })).toEqual({ auto: null, reserved: null });
  });

  it('rejects NaN reserved', () => {
    expect(normalizeCompactionSettings({ reserved: NaN })).toEqual({ auto: null, reserved: null });
  });

  it('rejects non-number reserved', () => {
    expect(normalizeCompactionSettings({ reserved: '100' as unknown as number })).toEqual({
      auto: null,
      reserved: null,
    });
  });

  it('preserves both fields together', () => {
    expect(normalizeCompactionSettings({ auto: true, reserved: 1024 })).toEqual({
      auto: true,
      reserved: 1024,
    });
  });
});

describe('areCompactionSettingsEqual', () => {
  it('returns true for identical object reference', () => {
    const a = { auto: true, reserved: 100 };
    expect(areCompactionSettingsEqual(a, a)).toBe(true);
  });

  it('returns true for equal settings', () => {
    expect(
      areCompactionSettingsEqual({ auto: false, reserved: 0 }, { auto: false, reserved: 0 })
    ).toBe(true);
  });

  it('returns false when auto differs', () => {
    expect(
      areCompactionSettingsEqual({ auto: true, reserved: null }, { auto: false, reserved: null })
    ).toBe(false);
  });

  it('returns false when reserved differs', () => {
    expect(
      areCompactionSettingsEqual({ auto: null, reserved: 10 }, { auto: null, reserved: 20 })
    ).toBe(false);
  });

  it('returns false when auto is null vs boolean', () => {
    expect(
      areCompactionSettingsEqual({ auto: null, reserved: null }, { auto: true, reserved: null })
    ).toBe(false);
  });

  it('returns true when both are fully null', () => {
    expect(
      areCompactionSettingsEqual({ auto: null, reserved: null }, { auto: null, reserved: null })
    ).toBe(true);
  });
});
