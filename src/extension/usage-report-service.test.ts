/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These report tests deliberately model malformed external usage responses and imported adapter boundaries. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

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

const workerMocks = vi.hoisted(() => {
  class FakeWorker {
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly terminate = vi.fn(async () => 0);

    constructor() {
      instances.push(this);
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener);
      return this;
    }
  }

  const instances: FakeWorker[] = [];
  return { FakeWorker, instances };
});

vi.mock('node:worker_threads', () => ({
  default: { Worker: workerMocks.FakeWorker },
  Worker: workerMocks.FakeWorker,
}));

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
      time: { created, completed: created + 2_500 },
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
    service: new UsageReportService({ request }, ensureServerStarted, null),
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
  it('opens the report as a named Markdown preview', async () => {
    const uri = {
      scheme: 'varro-tool-output',
      path: '/id/OpenCode Usage Report.md',
    } as vscode.Uri;
    const openDocument = vi.fn(async () => uri);
    const service = new UsageReportService(
      { request: vi.fn<Request>() },
      vi.fn(async () => undefined),
      async () => ({ sessionCount: 0, usage: [] }),
      openDocument
    );

    await service.openReport();

    expect(openDocument).toHaveBeenCalledWith(
      expect.stringContaining('# OpenCode Usage Report'),
      'OpenCode Usage Report'
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('markdown.showPreview', uri);
  });

  it('shares overlapping equivalent report commands instead of spawning duplicate work', async () => {
    let resolveUsage!: (value: { sessionCount: number; usage: [] }) => void;
    const readLocalUsage = vi.fn(
      () =>
        new Promise<{ sessionCount: number; usage: [] }>((resolve) => {
          resolveUsage = resolve;
        })
    );
    const service = new UsageReportService(
      { request: vi.fn<Request>() },
      vi.fn(async () => undefined),
      readLocalUsage
    );

    const first = service.openReport();
    const second = service.openReport();

    expect(second).toBe(first);
    expect(readLocalUsage).toHaveBeenCalledOnce();
    resolveUsage({ sessionCount: 0, usage: [] });
    await Promise.all([first, second]);
  });

  it('queues a different report mode behind the active report', async () => {
    let resolveUsage!: (value: { sessionCount: number; usage: [] }) => void;
    const readLocalUsage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ sessionCount: number; usage: [] }>((resolve) => {
            resolveUsage = resolve;
          })
      )
      .mockResolvedValueOnce({ sessionCount: 0, usage: [] });
    const service = new UsageReportService(
      { request: vi.fn<Request>() },
      vi.fn(async () => undefined),
      readLocalUsage
    );

    const recent = service.openReport();
    const allTime = service.openReport(true);
    expect(allTime).not.toBe(recent);
    expect(readLocalUsage).toHaveBeenCalledOnce();

    resolveUsage({ sessionCount: 0, usage: [] });
    await Promise.all([recent, allTime]);
    expect(readLocalUsage).toHaveBeenNthCalledWith(2, undefined, NOW.getTime(), true);
  });

  it('uses local usage metadata without requesting every session history', async () => {
    const request = vi.fn<Request>();
    const readLocalUsage = vi.fn(async () => ({
      sessionCount: 2,
      usage: [
        {
          providerID: 'provider-local',
          modelID: 'model-local',
          promptID: 'session-1\u0000prompt-1',
          created: NOW.getTime(),
          durationMs: 25 * 60 * 60 * 1_000,
          tokens: {
            total: 100,
            input: 70,
            output: 20,
            reasoning: 10,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      ],
    }));
    const service = new UsageReportService(
      { request },
      vi.fn(async () => undefined),
      readLocalUsage
    );

    await service.openReport();

    expect(readLocalUsage).toHaveBeenCalledWith(RECENT_START, NOW.getTime(), false);
    expect(request).not.toHaveBeenCalled();
    expect(reportContent()).toContain('from 2 sessions scanned');
    expect(reportSection(reportContent(), 'Today')).toContain(
      '| provider-local | model-local | 1 | 100 | 25h | 70 | 20 | 10 | 0 | 0 |'
    );
  });

  it('terminates a stalled local database worker without starting a full-history fallback', async () => {
    const request = vi.fn<Request>(async () => ({ data: [] }));
    const service = new UsageReportService(
      { request },
      vi.fn(async () => undefined)
    );

    const report = service.openReport();
    const rejected = expect(report).rejects.toThrow(
      'Local OpenCode usage query timed out after 30 seconds'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;

    expect(workerMocks.instances).toHaveLength(1);
    expect(workerMocks.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('renders compact aggregates returned by the local database worker', async () => {
    const request = vi.fn<Request>();
    const service = new UsageReportService(
      { request },
      vi.fn(async () => undefined)
    );

    const report = service.openReport();
    await Promise.resolve();
    await Promise.resolve();
    workerMocks.instances.at(-1)?.listeners.get('message')?.({
      sessionCount: 2_209,
      windows: Array.from({ length: 3 }, () => ({
        totalPromptCount: 9,
        groups: [
          {
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            prompts: 9,
            durationMs: 9_000,
            durationCount: 9,
            total: 35_101_345,
            input: 1_734_846,
            output: 61_048,
            reasoning: 136_555,
            cacheRead: 33_168_896,
            cacheWrite: 0,
          },
        ],
      })),
    });
    await report;

    expect(request).not.toHaveBeenCalled();
    expect(reportContent()).toContain('from 2,209 sessions scanned');
    expect(reportSection(reportContent(), 'Today')).toContain(
      '| openai | gpt-5.6-sol | 9 | 35,101,345 | 9s |'
    );
  });

  it('refuses an unbounded server fallback when too many sessions need full histories', async () => {
    const sessions = Array.from({ length: 251 }, (_, index) =>
      session(`session-${index}`, '/repo', index)
    );
    const request = vi.fn<Request>(async (_method, path) => {
      if (path.startsWith('/experimental/session')) return { data: sessions };
      throw new Error(`Unexpected request ${path}`);
    });
    const service = new UsageReportService(
      { request },
      vi.fn(async () => undefined),
      async () => null
    );

    await expect(service.openReport()).rejects.toThrow(
      'Refusing to fetch full history for 251 sessions'
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it('stops paginating the server fallback as soon as its session limit is exceeded', async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce({
        data: Array.from({ length: 250 }, (_, index) =>
          session(`session-${index}`, '/repo', index)
        ),
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [session('session-250', '/repo', 250)],
        nextCursor: 'page-3',
      });
    const service = new UsageReportService(
      { request },
      vi.fn(async () => undefined),
      async () => null
    );

    await expect(service.openReport()).rejects.toThrow(
      'Refusing to fetch full history for 251 sessions'
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

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
      '/session/session-1/message?directory=%2Frepo%20one',
      undefined,
      {
        maxResponseBytes: 256 * 1024 * 1024,
        maxProjectedResponseBytes: 16 * 1024 * 1024,
        stripMessageParts: true,
        stripSummaryDiffs: true,
      }
    );
    expect(reportSection(reportContent(), 'Today')).toContain(
      '| provider-a | model-a | 1 | 190 | 3s | 100 | 50 | 25 | 10 | 5 |'
    );
    expect(reportSection(reportContent(), 'Last 7 rolling days')).toContain(
      '| provider-a | model-a | 1 | 190 |'
    );
    expect(reportSection(reportContent(), 'Last 30 rolling days')).toContain(
      '| provider-a | model-a | 2 | 380 |'
    );
    expect(reportContent()).toContain('| Provider | Model | Prompts |');
    expect(reportContent()).toContain('| Total | Duration | Input |');
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

  it('prunes cached usage when a session is deleted or ages out of a recent listing', async () => {
    let listingCount = 0;
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path.startsWith('/experimental/session')) {
        listingCount += 1;
        return {
          data: listingCount === 2 ? [] : [session('session-1', '/repo', 10)],
        };
      }
      if (method === 'GET' && path === '/session/session-1/message?directory=%2Frepo') {
        return [assistant('assistant-1', NOW.getTime())];
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service } = createService(request);

    await service.openReport();
    await service.openReport();
    await service.openReport();

    expect(
      request.mock.calls.filter(([, path]) => path.startsWith('/session/session-1/message'))
    ).toHaveLength(2);
  });

  it('clears server fallback usage when the local database recovers', async () => {
    let localReadCount = 0;
    const readLocalUsage = vi.fn(async () => {
      localReadCount += 1;
      return localReadCount === 2 ? { sessionCount: 0, usage: [] } : null;
    });
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path.startsWith('/experimental/session')) {
        return { data: [session('session-1', '/repo', 10)] };
      }
      if (method === 'GET' && path === '/session/session-1/message?directory=%2Frepo') {
        return [assistant('assistant-1', NOW.getTime())];
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const service = new UsageReportService(
      { request },
      vi.fn(async () => undefined),
      readLocalUsage
    );

    await service.openReport();
    await service.openReport();
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

  it('ignores missing or reversed assistant timing', async () => {
    const request = vi.fn<Request>(async (method, path) => {
      if (method === 'GET' && path.startsWith('/experimental/session')) {
        return { data: [session('session-1', '/repo', 10)] };
      }
      if (method === 'GET' && path.startsWith('/session/session-1/message')) {
        return [
          assistant('valid', NOW.getTime(), {
            modelID: 'valid',
            time: { created: NOW.getTime(), completed: NOW.getTime() + 500 },
          }),
          assistant('missing', NOW.getTime(), {
            modelID: 'invalid',
            time: { created: NOW.getTime() },
          }),
          assistant('reversed', NOW.getTime(), {
            modelID: 'invalid',
            time: { created: NOW.getTime(), completed: NOW.getTime() - 1_000 },
          }),
        ];
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const { service } = createService(request);

    await service.openReport();

    expect(reportSection(reportContent(), 'Today')).toContain(
      '| provider-a | valid | 1 | 190 | <1s | 100 | 50 | 25 | 10 | 5 |'
    );
    expect(reportSection(reportContent(), 'Today')).toContain(
      '| provider-a | invalid | 2 | 380 | - | 200 | 100 | 50 | 20 | 10 |'
    );
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
