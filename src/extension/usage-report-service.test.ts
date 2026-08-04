import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const documentUri = { scheme: 'untitled', path: '/OpenCode Usage Report.md' };
  const openTextDocument = vi.fn(async (options: unknown) => ({ options, uri: documentUri }));
  const showTextDocument = vi.fn(async () => undefined);
  const showErrorMessage = vi.fn(async () => undefined);
  const withProgress = vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task());
  const executeCommand = vi.fn(async () => undefined);
  return {
    documentUri,
    executeCommand,
    openTextDocument,
    showTextDocument,
    showErrorMessage,
    withProgress,
  };
});

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: mocks.executeCommand },
  workspace: { openTextDocument: mocks.openTextDocument },
  window: {
    showTextDocument: mocks.showTextDocument,
    showErrorMessage: mocks.showErrorMessage,
    withProgress: mocks.withProgress,
  },
}));

import type { OpenCodeServer } from './server';
import { UsageReportService } from './usage-report-service';

type Request = OpenCodeServer['request'];

const NOW = new Date(2026, 7, 3, 12, 0, 0, 0);
const RECENT_START = NOW.getTime() - 30 * 24 * 60 * 60 * 1000;

function session(id: string, directory: string, updated: number): unknown {
  return { id, directory, time: { updated } };
}

function assistant(id: string, created: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    info: {
      id,
      role: 'assistant',
      parentID: `prompt-${id}`,
      providerID: 'provider-a',
      modelID: 'model-a',
      time: { created },
      tokens: {
        input: 100,
        output: 50,
        reasoning: 25,
        cache: { read: 10, write: 5 },
        total: 190,
      },
      ...overrides,
    },
  };
}

function createService(
  request: Request,
  ensureServerStarted = vi.fn(async () => undefined)
): { service: UsageReportService; ensureServerStarted: typeof ensureServerStarted } {
  return {
    service: new UsageReportService({ request }, ensureServerStarted),
    ensureServerStarted,
  };
}

function reportContent(): string {
  const options = mocks.openTextDocument.mock.calls.at(-1)?.[0] as { content?: string } | undefined;
  return options?.content || '';
}

function reportSection(content: string, title: string): string {
  return content.split(`## ${title}\n`)[1]?.split('\n## ')[0] || '';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageReportService', () => {
  it('scans global sessions with one history request each and renders token windows', async () => {
    const today = NOW.getTime() - 60_000;
    const eightDaysAgo = NOW.getTime() - 8 * 24 * 60 * 60 * 1000;
    const request = vi.fn<Request>(async (method, path) => {
      if (
        method === 'GET' &&
        path === `/experimental/session?archived=true&limit=1000&start=${RECENT_START}`
      ) {
        return {
          data: [session('session-1', '/repo one', 10)],
          nextCursor: 'page-2',
        };
      }
      if (
        method === 'GET' &&
        path ===
          `/experimental/session?archived=true&limit=1000&start=${RECENT_START}&cursor=page-2`
      ) {
        return { data: [session('session-2', '/repo-two', 20)] };
      }
      if (method === 'GET' && path === '/session/session-1/message?directory=%2Frepo%20one') {
        return [assistant('today', today), assistant('older', eightDaysAgo)];
      }
      if (method === 'GET' && path === '/session/session-2/message?directory=%2Frepo-two') {
        throw new Error('history unavailable');
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service, ensureServerStarted } = createService(request);

    await service.openReport();

    expect(ensureServerStarted).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      'GET',
      `/experimental/session?archived=true&limit=1000&start=${RECENT_START}`,
      undefined,
      { unscoped: true, captureNextCursor: true }
    );
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/session/session-1/message?directory=%2Frepo%20one'
    );
    expect(reportSection(reportContent(), 'Today')).toContain(
      '| provider-a | model-a | 1 | 190 | 100 | 50 | 25 | 10 | 5 |'
    );
    expect(reportSection(reportContent(), 'Last 7 rolling days')).toContain(
      '| provider-a | model-a | 1 | 190 |'
    );
    expect(reportSection(reportContent(), 'Last 30 rolling days')).toContain(
      '| provider-a | model-a | 2 | 380 |'
    );
    expect(reportContent()).toContain('| Provider | Model | Prompts |');
    expect(reportContent()).not.toContain('## All time');
    expect(reportContent()).toContain(
      '- Could not read messages for session session-2: history unavailable.'
    );
    expect(reportContent()).not.toContain('cost');
    expect(mocks.showTextDocument).toHaveBeenCalledWith(expect.anything(), { preview: false });
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', mocks.documentUri);
  });

  it('reuses cached usage until the session update timestamp changes', async () => {
    let updated = 10;
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path.startsWith('/experimental/session')) {
        return { data: [session('session-1', '/repo', updated)] };
      }
      if (method === 'GET' && path === '/session/session-1/message?directory=%2Frepo') {
        return [assistant(`assistant-${updated}`, NOW.getTime())];
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service } = createService(request);

    await service.openReport();
    await service.openReport();
    updated = 11;
    await service.openReport();

    expect(
      request.mock.calls.filter(([, path]) => path.startsWith('/session/session-1/message'))
    ).toHaveLength(2);
  });

  it('sorts by prompts then total tokens descending and omits zero-token models', async () => {
    const usage = [
      assistant('large', NOW.getTime(), {
        modelID: 'large',
        tokens: tokenDetails(3_000),
      }),
      assistant('frequent-1', NOW.getTime(), {
        modelID: 'frequent',
        tokens: tokenDetails(10),
      }),
      assistant('frequent-2', NOW.getTime(), {
        modelID: 'frequent',
        tokens: tokenDetails(10),
      }),
      assistant('small', NOW.getTime(), {
        modelID: 'small',
        tokens: tokenDetails(20),
      }),
      assistant('zero', NOW.getTime(), {
        modelID: 'zero',
        tokens: tokenDetails(0),
      }),
    ];
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path.startsWith('/experimental/session')) {
        return { data: [session('session-1', '/repo', 10)] };
      }
      if (method === 'GET' && path.startsWith('/session/session-1/message')) return usage;
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service } = createService(request);

    await service.openReport();

    const section = reportSection(reportContent(), 'Today');
    const frequentIndex = section.indexOf('| provider-a | frequent |');
    const largeIndex = section.indexOf('| provider-a | large |');
    const smallIndex = section.indexOf('| provider-a | small |');
    expect(frequentIndex).toBeGreaterThan(-1);
    expect(largeIndex).toBeGreaterThan(frequentIndex);
    expect(smallIndex).toBeGreaterThan(largeIndex);
    expect(section).not.toContain('| provider-a | zero |');
  });

  it('counts multiple assistant responses to the same parent as one prompt', async () => {
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path.startsWith('/experimental/session')) {
        return { data: [session('session-1', '/repo', 10)] };
      }
      if (method === 'GET' && path.startsWith('/session/session-1/message')) {
        return [
          assistant('response-1', NOW.getTime(), { parentID: 'prompt-1' }),
          assistant('response-2', NOW.getTime(), { parentID: 'prompt-1' }),
        ];
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service } = createService(request);

    await service.openReport();

    expect(reportSection(reportContent(), 'Today')).toContain('| provider-a | model-a | 1 | 380 |');
  });

  it('silently ignores malformed token details', async () => {
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path.startsWith('/experimental/session')) {
        return { data: [session('session-1', '/repo', 10)] };
      }
      if (method === 'GET' && path.startsWith('/session/session-1/message')) {
        return [
          assistant('malformed', NOW.getTime(), {
            tokens: { input: 'unknown', cache: null },
          }),
        ];
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service } = createService(request);

    await service.openReport();

    expect(reportContent()).not.toContain('malformed token details');
    expect(reportSection(reportContent(), 'Today')).toContain('_No token usage._');
  });

  it('detects repeated global cursors', async () => {
    const request = vi.fn<Request>(async (_method, path) => {
      if (path.startsWith('/experimental/session')) {
        return { data: [], nextCursor: 'same-cursor' };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const { service } = createService(request);

    await service.openReport();

    expect(
      request.mock.calls.filter(([, path]) => path.startsWith('/experimental/session'))
    ).toHaveLength(2);
    expect(reportContent()).toContain(
      '- Stopped session pagination because OpenCode repeated cursor same-cursor.'
    );
  });

  it('includes retained all-time usage only when requested', async () => {
    const oldUsage = NOW.getTime() - 365 * 24 * 60 * 60 * 1000;
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path === '/experimental/session?archived=true&limit=1000') {
        return { data: [session('session-old', '/repo', 10)] };
      }
      if (method === 'GET' && path === '/session/session-old/message?directory=%2Frepo') {
        return [assistant('old', oldUsage)];
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service } = createService(request);

    await service.openReport(true);

    expect(reportSection(reportContent(), 'All time')).toContain(
      '| provider-a | model-a | 1 | 190 |'
    );
  });

  it('surfaces and rethrows a global session-list failure', async () => {
    const request = vi.fn<Request>(async () => {
      throw new Error('server is offline');
    });
    const { service } = createService(request);

    await expect(service.openReport()).rejects.toThrow(
      'Failed to list retained OpenCode sessions: server is offline'
    );
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      'Could not build OpenCode usage report: Failed to list retained OpenCode sessions: server is offline'
    );
  });
});

function tokenDetails(total: number): Record<string, unknown> {
  return {
    input: total,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total,
  };
}
