import { describe, expect, it } from 'vitest';
import { isAllowedApiRequest, isAllowedExternalUrl, parseWebviewMessage } from './webview-message';

function createRalphConfig() {
  return {
    managerSessionId: 'manager-1',
    planDocPath: 'RALPH.md',
    iterations: 5,
    promptTemplate: 'Follow the plan',
    permissionMode: 'full',
    model: { providerID: 'openai', modelID: 'gpt-5', variant: 'high' },
    agent: null,
    createdAt: 100,
  };
}

function createRalphRun() {
  return {
    config: createRalphConfig(),
    status: 'paused',
    currentIteration: 1,
    iterations: [
      {
        index: 1,
        childSessionId: 'child-1',
        status: 'passed',
        phase: 'verification',
        startedAt: 101,
        endedAt: 102,
        filesChanged: ['src/app.ts'],
        verification: { lint: 'pass', test: 'skipped' },
        tokens: {
          input: 1,
          output: 2,
          reasoning: 3,
          cacheRead: 4,
          cacheWrite: 5,
          total: 6,
        },
        cost: 0.1,
        note: 'Implemented the next item.',
        repairSessionIds: ['repair-1'],
      },
    ],
    updatedAt: 103,
  };
}

describe('webview message validation', () => {
  it('accepts known API routes used by the webview client', () => {
    expect(isAllowedApiRequest('GET', '/command')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/init')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/prompt_async')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/command')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/fork')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session/abc/diff?messageID=msg-1')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session/abc/message')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session/abc/message?limit=200')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session/abc/message?limit=200&before=cursor-2')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/session/abc/message/message-1')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session/abc/todo')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/unrevert')).toBe(true);
    expect(isAllowedApiRequest('POST', '/question/request-1/reply')).toBe(true);
    expect(isAllowedApiRequest('GET', '/permission')).toBe(true);
    expect(isAllowedApiRequest('POST', '/permission/request-1/reply')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/provider-limit?providerID=openai')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/workspace-file?path=package.json')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/workspace-path/resolve?path=package.json')).toBe(
      true
    );
    expect(isAllowedApiRequest('GET', '/varro/workspace-file/pick')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/opencode-config')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/opencode-config/model-routing')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/permission/judge')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/session/session-1/diff-summary')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/session/session-1/pin')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/session/session-1/rename-if-untitled')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/session/session-1/delete')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/session-trash')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/session-trash/session-1/restore')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash/session-1/delete')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/plan/open')).toBe(true);
    expect(isAllowedApiRequest('GET', '/mcp')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/connect')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/disconnect')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/auth/authenticate')).toBe(true);
    expect(isAllowedApiRequest('GET', '/provider/auth')).toBe(true);
    expect(isAllowedApiRequest('POST', '/provider/openai/oauth/authorize')).toBe(true);
    expect(isAllowedApiRequest('POST', '/provider/openai/oauth/callback')).toBe(true);
    expect(isAllowedApiRequest('GET', '/experimental/workspace/status')).toBe(true);
    expect(isAllowedApiRequest('POST', '/experimental/workspace/warp')).toBe(true);
    expect(isAllowedApiRequest('GET', '/global/config')).toBe(true);
  });

  it('rejects absolute and unsupported API routes', () => {
    expect(isAllowedApiRequest('GET', 'https://example.com/session')).toBe(false);
    expect(isAllowedApiRequest('GET', '//example.com/session')).toBe(false);
    expect(isAllowedApiRequest('GET', '/experimental/console')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/config/providers')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/diff?messageID=1&extra=1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/message?limit=5&extra=1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/message?before=cursor-2')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session/abc/message?limit=5')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/message/message-1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/provider-limit?modelID=gpt')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/workspace-file')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/workspace-path/resolve')).toBe(false);
    expect(isAllowedApiRequest('POST', '/varro/opencode-config')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/opencode-config/model-routing')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/permission/judge')).toBe(false);
    expect(isAllowedApiRequest('POST', '/varro/session/session-1/diff-summary')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/session/session-1/pin')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/session/session-1/diff-summary?messageID=1')).toBe(
      false
    );
    expect(isAllowedApiRequest('GET', '/varro/session/session-1/diff-summary/extra')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/session/session-1/rename-if-untitled')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/plan/open')).toBe(false);
    expect(isAllowedApiRequest('POST', '/varro/session/session-1/delete')).toBe(false);
    expect(isAllowedApiRequest('POST', '/varro/session-trash/session-1/delete')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash/session-1/restore')).toBe(false);
    expect(isAllowedApiRequest('GET', '/provider/openai/oauth/authorize')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session/session-1/permissions/perm-1')).toBe(false);
  });

  it('preserves route precedence so specific patterns shadow param patterns', () => {
    // `/session/status` must resolve via its own route, not the `/session/:id`
    // catch-all, so a non-GET method is rejected rather than treated as a session id.
    expect(isAllowedApiRequest('GET', '/session/status')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/session/status')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/session/abc')).toBe(true);

    // `/session/:id/diff` is GET-only and must not fall through to the POST action list.
    expect(isAllowedApiRequest('POST', '/session/abc/diff')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session/abc/not-an-action')).toBe(false);

    // Action enums on param routes only accept their whitelisted final segment.
    expect(isAllowedApiRequest('POST', '/mcp/server/connect')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/server/restart')).toBe(false);
    expect(isAllowedApiRequest('POST', '/question/req/reject')).toBe(true);
    expect(isAllowedApiRequest('POST', '/question/req/approve')).toBe(false);

    // Deeper-than-known session paths have no matching route.
    expect(isAllowedApiRequest('GET', '/session/abc/message/extra')).toBe(false);
  });

  it('rejects unsafe extension-host actions from malformed messages', () => {
    expect(
      parseWebviewMessage({
        type: 'terminal/run',
        payload: { command: 'rm -rf .', title: 'Nope' },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'vscode/open-external',
        payload: { url: 'command:workbench.action.reloadWindow' },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: { id: 1, method: 'GET', path: 'https://example.com/' },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'vscode/open-external',
        payload: { url: 'http://example.com' },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'terminal/run',
        payload: { command: 'opencode auth', title: 'Auth' },
      })
    ).toEqual({
      type: 'terminal/run',
      payload: { command: 'opencode auth', title: 'Auth' },
    });
  });

  it('allows only https external URLs', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(false);
  });

  it('normalizes accepted API request methods to uppercase', () => {
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: { id: 1, method: 'get', path: '/session' },
      })
    ).toEqual({ type: 'api/request', payload: { id: 1, method: 'GET', path: '/session' } });
  });

  it('sanitizes bounded JSON-compatible API request bodies', () => {
    const body = {
      parts: [{ type: 'text', text: 'Implement the next item' }],
      model: { providerID: 'openai', modelID: 'gpt-5' },
      noReply: false,
      metadata: null,
      variant: undefined,
    };

    const parsed = parseWebviewMessage({
      type: 'api/request',
      payload: { id: 1, method: 'POST', path: '/session/session-1/prompt_async', body },
    });

    expect(parsed).toEqual({
      type: 'api/request',
      payload: { id: 1, method: 'POST', path: '/session/session-1/prompt_async', body },
    });
    if (parsed?.type === 'api/request') {
      expect(parsed.payload.body).not.toBe(body);
      expect(Object.hasOwn(parsed.payload.body as object, 'variant')).toBe(false);
    }
  });

  it('rejects unsafe or structurally excessive API request bodies', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 30; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const tooLongString = 'x'.repeat(8 * 1024 * 1024 + 1);

    const invalidBodies: unknown[] = [
      cyclic,
      deep,
      { value: () => true },
      { value: Symbol('nope') },
      { value: 1n },
      { value: Number.NaN },
      Array.from({ length: 5_001 }, () => null),
      Array.from({ length: 4_500 }, () => ({ first: 1, second: 2 })),
      { value: tooLongString },
      Object.defineProperty({}, 'hidden', { value: true }),
      { [Symbol('key')]: true },
    ];

    for (const body of invalidBodies) {
      expect(
        parseWebviewMessage({
          type: 'api/request',
          payload: { id: 1, method: 'POST', path: '/session', body },
        })
      ).toBeNull();
    }
  });

  it('accepts a request to open filtered VS Code settings', () => {
    expect(
      parseWebviewMessage({
        type: 'vscode/open-settings',
        payload: { query: 'Varro' },
      })
    ).toEqual({ type: 'vscode/open-settings', payload: { query: 'Varro' } });

    expect(parseWebviewMessage({ type: 'vscode/open-settings', payload: {} })).toEqual({
      type: 'vscode/open-settings',
      payload: {},
    });
  });

  it('accepts providers/refresh without payload', () => {
    expect(parseWebviewMessage({ type: 'providers/refresh' })).toEqual({
      type: 'providers/refresh',
    });
    expect(parseWebviewMessage({ type: 'vscode/show-output' })).toEqual({
      type: 'vscode/show-output',
    });
  });

  it('accepts providers/watch with active state', () => {
    expect(parseWebviewMessage({ type: 'providers/watch', payload: { active: true } })).toEqual({
      type: 'providers/watch',
      payload: { active: true },
    });
  });

  it('accepts session export messages with a valid session id', () => {
    expect(
      parseWebviewMessage({ type: 'session/export', payload: { sessionId: 'session-1' } })
    ).toEqual({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    expect(parseWebviewMessage({ type: 'session/export', payload: {} })).toBeNull();
  });

  it('parses every Ralph command and reconstructs nested legacy runs', () => {
    const config = createRalphConfig();
    const run = createRalphRun();

    expect(
      parseWebviewMessage({ type: 'ralph/start', payload: { config, ignored: true } })
    ).toEqual({ type: 'ralph/start', payload: { config } });

    for (const type of ['ralph/stop', 'ralph/pause', 'ralph/resume'] as const) {
      expect(parseWebviewMessage({ type, payload: { managerSessionId: 'manager-1' } })).toEqual({
        type,
        payload: { managerSessionId: 'manager-1' },
      });
    }

    expect(
      parseWebviewMessage({
        type: 'ralph/update-model',
        payload: {
          managerSessionId: 'manager-1',
          model: { providerID: 'anthropic', modelID: 'claude', variant: 'max' },
        },
      })
    ).toEqual({
      type: 'ralph/update-model',
      payload: {
        managerSessionId: 'manager-1',
        model: { providerID: 'anthropic', modelID: 'claude', variant: 'max' },
      },
    });
    expect(
      parseWebviewMessage({
        type: 'ralph/update-model',
        payload: { managerSessionId: 'manager-1', model: null },
      })
    ).toEqual({
      type: 'ralph/update-model',
      payload: { managerSessionId: 'manager-1', model: null },
    });

    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: { legacyRuns: { 'manager-1': run } },
      })
    ).toEqual({
      type: 'ralph/sync',
      payload: { legacyRuns: { 'manager-1': run } },
    });
    expect(parseWebviewMessage({ type: 'ralph/sync', payload: {} })).toEqual({
      type: 'ralph/sync',
      payload: {},
    });
  });

  it('rejects malformed or unbounded Ralph command payloads', () => {
    expect(
      parseWebviewMessage({
        type: 'ralph/start',
        payload: { config: { ...createRalphConfig(), iterations: 1_000 } },
      })
    ).not.toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/start',
        payload: { config: { ...createRalphConfig(), iterations: 1_001 } },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: {
          legacyRuns: {
            'manager-1': {
              ...createRalphRun(),
              iterations: [{ ...createRalphRun().iterations[0], phase: 'unknown' }],
            },
          },
        },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/start',
        payload: {
          config: {
            ...createRalphConfig(),
            model: { providerID: 'openai', modelID: '' },
          },
        },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/stop',
        payload: { managerSessionId: 'x'.repeat(513) },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/update-model',
        payload: { managerSessionId: 'manager-1', model: {} },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: {
          legacyRuns: {
            'manager-1': { ...createRalphRun(), status: 'unknown' },
          },
        },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: {
          legacyRuns: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [
              `manager-${index}`,
              {
                ...createRalphRun(),
                config: { ...createRalphConfig(), managerSessionId: `manager-${index}` },
              },
            ])
          ),
        },
      })
    ).toBeNull();
  });

  it('rejects reserved Ralph manager, legacy record, and nested session IDs', () => {
    expect(
      parseWebviewMessage({
        type: 'ralph/start',
        payload: { config: { ...createRalphConfig(), managerSessionId: 'constructor' } },
      })
    ).toBeNull();

    for (const type of ['ralph/stop', 'ralph/pause', 'ralph/resume'] as const) {
      expect(parseWebviewMessage({ type, payload: { managerSessionId: 'prototype' } })).toBeNull();
    }
    expect(
      parseWebviewMessage({
        type: 'ralph/update-model',
        payload: { managerSessionId: '__proto__', model: null },
      })
    ).toBeNull();

    const reservedRun = {
      ...createRalphRun(),
      config: { ...createRalphConfig(), managerSessionId: '__proto__' },
    };
    const legacyRuns = JSON.parse(`{"__proto__":${JSON.stringify(reservedRun)}}`) as Record<
      string,
      unknown
    >;
    expect(parseWebviewMessage({ type: 'ralph/sync', payload: { legacyRuns } })).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: {
          legacyRuns: {
            'manager-1': {
              ...createRalphRun(),
              iterations: [{ ...createRalphRun().iterations[0], childSessionId: 'constructor' }],
            },
          },
        },
      })
    ).toBeNull();
  });

  it('enforces cumulative Ralph string, node, and path-entry budgets', () => {
    const sharedPrompt = 'x'.repeat(90_000);
    const stringHeavyRuns = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => {
        const managerSessionId = `manager-${index}`;
        return [
          managerSessionId,
          {
            config: {
              ...createRalphConfig(),
              managerSessionId,
              promptTemplate: sharedPrompt,
            },
            status: 'paused',
            currentIteration: 0,
            iterations: [],
            updatedAt: 100,
          },
        ];
      })
    );
    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: { legacyRuns: stringHeavyRuns },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'ralph/start',
        payload: {
          config: {
            ...createRalphConfig(),
            ignored: Array.from({ length: 100_001 }, () => null),
          },
        },
      })
    ).toBeNull();

    const filesChanged = Array.from({ length: 21 }, (_, index) => `src/file-${index}.ts`);
    const pathHeavyRun = {
      ...createRalphRun(),
      config: { ...createRalphConfig(), iterations: 1_000 },
      currentIteration: 1_000,
      iterations: Array.from({ length: 1_000 }, (_, index) => ({
        index: index + 1,
        childSessionId: `child-${index}`,
        status: 'passed',
        startedAt: 100 + index,
        endedAt: 101 + index,
        filesChanged,
        verification: {},
      })),
    };
    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: { legacyRuns: { 'manager-1': pathHeavyRun } },
      })
    ).toBeNull();
  });

  it('rejects malformed payloads for typed messages', () => {
    expect(parseWebviewMessage({ type: 'webview/focus', payload: { focused: 'yes' } })).toBeNull();
    expect(parseWebviewMessage({ type: 'providers/watch', payload: { active: 'yes' } })).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'files/search',
        payload: { requestId: 1.5, query: 'src', limit: -1 },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'files/drop-content',
        payload: {
          files: [{ name: 'note.txt', content: 'Zm9v', size: 10 * 1024 * 1024 + 1 }],
        },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          showStickyUserPrompt: true,
          desktopSessionPaneSide: 'bottom',
          defaultPermissionMode: 'full',
        },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({ type: 'log', payload: { msg: 'hello', level: 'debug' } })
    ).toBeNull();
  });

  it('validates dropped-content encoding, declared sizes, and aggregate limits', () => {
    expect(
      parseWebviewMessage({
        type: 'files/drop-content',
        payload: { files: [{ name: 'note.txt', content: 'aGVsbG8=', size: 5 }] },
      })
    ).toEqual({
      type: 'files/drop-content',
      payload: { files: [{ name: 'note.txt', content: 'aGVsbG8=', size: 5 }] },
    });

    expect(
      parseWebviewMessage({
        type: 'files/drop-content',
        payload: { files: [{ name: 'note.txt', content: 'aGVsbG8=', size: 4 }] },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'files/drop-content',
        payload: { files: [{ name: 'note.txt', content: '!!!!', size: 3 }] },
      })
    ).toBeNull();

    const threeMiB = Buffer.alloc(3 * 1024 * 1024).toString('base64');
    expect(
      parseWebviewMessage({
        type: 'files/drop-content',
        payload: {
          files: Array.from({ length: 17 }, (_, index) => ({
            name: `part-${index}.bin`,
            content: threeMiB,
            size: 3 * 1024 * 1024,
          })),
        },
      })
    ).toBeNull();
  });

  it('accepts known message shapes from newer webview versions by ignoring extra fields', () => {
    expect(
      parseWebviewMessage({
        type: 'ready',
        version: '999',
        payload: { unsupported: true },
      })
    ).toEqual({ type: 'ready' });

    expect(
      parseWebviewMessage({
        type: 'vscode/open',
        version: '2',
        payload: {
          path: '/repo/src/app.ts',
          line: 12,
          kind: 'file',
          view: 'diff',
          column: 7,
          selection: { startLine: 12, endLine: 14 },
        },
      })
    ).toEqual({
      type: 'vscode/open',
      payload: { path: '/repo/src/app.ts', line: 12, kind: 'file', view: 'diff' },
    });

    expect(
      parseWebviewMessage({
        type: 'vscode/open',
        payload: { path: '/repo/src/app.ts', view: 'editor' },
      })
    ).toBeNull();
  });

  it('rejects malformed URLs and unsafe path traversal in helper guards', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/../message')).toBe(false);
    expect(isAllowedApiRequest('POST', '/mcp/%2F/connect')).toBe(false);
  });
});
