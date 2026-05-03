import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LoggerModule from './logger';

const { appendLineMock, createOutputChannelMock, disposeMock, showMock } = vi.hoisted(() => ({
  appendLineMock: vi.fn(),
  createOutputChannelMock: vi.fn(),
  disposeMock: vi.fn(),
  showMock: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: createOutputChannelMock,
  },
}));

let logger: typeof LoggerModule.logger;

describe('logger', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    createOutputChannelMock.mockReturnValue({
      appendLine: appendLineMock,
      show: showMock,
      dispose: disposeMock,
    });

    ({ logger } = await import('./logger'));
  });

  it('creates and writes to the Varro output channel', () => {
    logger.info('Started', { requestId: 'abc123' });
    logger.warn('Slow request');
    logger.error('Failed', new Error('boom'));

    expect(createOutputChannelMock).toHaveBeenCalledWith('Varro');
    expect(appendLineMock).toHaveBeenNthCalledWith(1, '[INFO] Started [{"requestId":"abc123"}]');
    expect(appendLineMock).toHaveBeenNthCalledWith(2, '[WARN] Slow request');
    expect(appendLineMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('[ERROR] Failed [{"name":"Error","message":"boom"')
    );
  });

  it('falls back to String(value) when an argument cannot be JSON-stringified', () => {
    const circular = { self: null as unknown };
    circular.self = circular;

    logger.info('Circular payload', circular);

    expect(appendLineMock).toHaveBeenCalledWith('[INFO] Circular payload [object Object]');
  });

  it('forwards show and dispose to the output channel', () => {
    logger.show();
    logger.dispose();

    expect(showMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});
