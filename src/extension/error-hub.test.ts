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

  it('routes warning and info reports to the matching logger and toast API', () => {
    const hub = new ErrorHub();

    hub.report({ code: 'generic', message: '  heads up  ', severity: 'warning' });
    hub.report({ code: 'generic', message: 'fyi', severity: 'info' });
    hub.report({ code: 'generic', message: '   ' });

    expect(loggerMock.warn).toHaveBeenCalledWith('[generic] heads up');
    expect(loggerMock.info).toHaveBeenCalledWith('[generic] fyi');
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith('heads up');
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith('fyi');
    expect(vscodeMock.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('ignores missing or unknown action selections', async () => {
    const hub = new ErrorHub();
    const run = vi.fn();

    vscodeMock.window.showErrorMessage.mockResolvedValueOnce(undefined);
    hub.report({
      code: 'generic',
      message: 'first action set',
      actions: [{ title: 'Retry', run }],
    });

    vscodeMock.window.showErrorMessage.mockResolvedValueOnce('Something else');
    hub.report({
      code: 'generic',
      message: 'second action set',
      actions: [{ title: 'Retry', run }],
    });

    await Promise.resolve();

    expect(run).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith('[generic] first action set');
    expect(loggerMock.error).toHaveBeenCalledWith('[generic] second action set');
  });

  it('logs rejected async actions and thrown sync actions', async () => {
    const hub = new ErrorHub();

    vscodeMock.window.showErrorMessage.mockResolvedValueOnce('Retry');
    hub.report({
      code: 'generic',
      message: 'async failure',
      actions: [
        {
          title: 'Retry',
          run: () => Promise.reject(new Error('async boom')),
        },
      ],
    });

    vscodeMock.window.showErrorMessage.mockResolvedValueOnce('Retry');
    hub.report({
      code: 'generic',
      message: 'sync failure',
      actions: [
        {
          title: 'Retry',
          run: () => {
            throw new Error('sync boom');
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(loggerMock.error).toHaveBeenCalledWith('ErrorHub action "Retry" failed: async boom');
      expect(loggerMock.error).toHaveBeenCalledWith('ErrorHub action "Retry" threw: sync boom');
    });
  });

  it('clears dedupe state so repeated messages can be shown again immediately', () => {
    const hub = new ErrorHub();

    hub.report({ code: 'generic', message: 'repeat me' });
    hub.clear();
    hub.report({ code: 'generic', message: 'repeat me' });

    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledTimes(2);
  });

  it('opens install docs and shows logs from the CLI missing shortcut actions', async () => {
    const hub = new ErrorHub();

    vscodeMock.window.showErrorMessage.mockResolvedValueOnce('Install instructions');
    hub.reportCliMissing('CLI not found');

    await vi.waitFor(() => {
      expect(vscodeMock.Uri.parse).toHaveBeenCalledWith('https://opencode.ai/docs/install/');
      expect(vscodeMock.env.openExternal).toHaveBeenCalledWith({
        value: 'https://opencode.ai/docs/install/',
      });
    });

    hub.clear();
    vscodeMock.window.showErrorMessage.mockResolvedValueOnce('Show logs');
    hub.reportCliMissing('CLI not found');

    await vi.waitFor(() => {
      expect(loggerMock.show).toHaveBeenCalled();
    });
  });
});
