import { beforeEach, describe, expect, it, vi } from 'vitest';

type ShowMessageMock = (message: string, ...items: string[]) => Promise<string | undefined>;

const { loggerMock, vscodeMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
  },
  vscodeMock: {
    window: {
      showInformationMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
      showWarningMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn<ShowMessageMock>(() => Promise.resolve(undefined)),
    },
    env: {
      openExternal: vi.fn(() => Promise.resolve(true)),
    },
    Uri: {
      parse: vi.fn((value: string) => ({ value })),
    },
  },
}));

vi.mock('./logger', () => ({ logger: loggerMock }));
vi.mock('vscode', () => vscodeMock);

import { ErrorHub } from './error-hub';

describe('ErrorHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00.000Z'));
  });

  it('deduplicates recent errors but prunes expired keys', () => {
    const hub = new ErrorHub();

    hub.report({ code: 'generic', message: 'first' });
    hub.report({ code: 'generic', message: 'first' });

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect((hub as unknown as { recentKeys: Map<string, number> }).recentKeys.size).toBe(1);

    vi.advanceTimersByTime(11_000);

    hub.report({ code: 'generic', message: 'second' });

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledTimes(2);
    expect((hub as unknown as { recentKeys: Map<string, number> }).recentKeys.size).toBe(1);
  });
});
