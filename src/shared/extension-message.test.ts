import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from './extension-message';

describe('parseExtensionMessage', () => {
  it('rejects non-objects and unknown types', () => {
    expect(parseExtensionMessage(null)).toBeNull();
    expect(parseExtensionMessage(undefined)).toBeNull();
    expect(parseExtensionMessage(42)).toBeNull();
    expect(parseExtensionMessage({ type: 'totally/unknown' })).toBeNull();
  });

  it('parses command messages', () => {
    expect(parseExtensionMessage({ type: 'command/new-session' })).toEqual({
      type: 'command/new-session',
    });
    expect(parseExtensionMessage({ type: 'command/focus-input' })).toEqual({
      type: 'command/focus-input',
    });
    expect(parseExtensionMessage({ type: 'command/open-attention-sessions' })).toEqual({
      type: 'command/open-attention-sessions',
    });
    expect(parseExtensionMessage({ type: 'command/abort' })).toEqual({ type: 'command/abort' });
  });

  it('parses server/status and rejects malformed variants', () => {
    expect(
      parseExtensionMessage({
        type: 'server/status',
        payload: { state: 'running', url: 'http://localhost:4096' },
      })
    ).toEqual({
      type: 'server/status',
      payload: { state: 'running', url: 'http://localhost:4096' },
    });

    expect(
      parseExtensionMessage({ type: 'server/status', payload: { state: 'running' } })
    ).toBeNull();
    expect(
      parseExtensionMessage({ type: 'server/status', payload: { state: 'starting' } })
    ).toEqual({
      type: 'server/status',
      payload: { state: 'starting' },
    });
    expect(parseExtensionMessage({ type: 'server/status', payload: { state: 'stopped' } })).toEqual(
      {
        type: 'server/status',
        payload: { state: 'stopped' },
      }
    );
    expect(
      parseExtensionMessage({
        type: 'server/status',
        payload: { state: 'error', message: 'failed to bind port' },
      })
    ).toEqual({
      type: 'server/status',
      payload: { state: 'error', message: 'failed to bind port' },
    });
    expect(
      parseExtensionMessage({ type: 'server/status', payload: { state: 'unknown' } })
    ).toBeNull();
  });

  it('parses api/response with data or error', () => {
    expect(
      parseExtensionMessage({ type: 'api/response', payload: { id: 1, data: { ok: true } } })
    ).toEqual({ type: 'api/response', payload: { id: 1, data: { ok: true } } });

    expect(
      parseExtensionMessage({ type: 'api/response', payload: { id: 2, error: 'bad' } })
    ).toEqual({
      type: 'api/response',
      payload: { id: 2, error: 'bad' },
    });

    expect(parseExtensionMessage({ type: 'api/response', payload: { id: 'x' } })).toBeNull();
  });

  it('parses server/event requiring a type', () => {
    expect(
      parseExtensionMessage({
        type: 'server/event',
        payload: { type: 'session.created', properties: { a: 1 } },
      })
    ).toEqual({
      type: 'server/event',
      payload: { type: 'session.created', properties: { a: 1 } },
    });

    expect(parseExtensionMessage({ type: 'server/event', payload: {} })).toBeNull();

    expect(
      parseExtensionMessage({
        type: 'server/event',
        payload: { type: 'session.updated' },
      })
    ).toEqual({
      type: 'server/event',
      payload: { type: 'session.updated' },
    });

    expect(
      parseExtensionMessage({
        type: 'server/event',
        payload: { type: 'mcp.tools.changed', properties: { name: 'browser-bridge' } },
      })
    ).toEqual({
      type: 'server/event',
      payload: { type: 'mcp.tools.changed', properties: { name: 'browser-bridge' } },
    });

    expect(
      parseExtensionMessage({
        type: 'server/event',
        payload: {
          type: 'workspace.status',
          properties: { workspaceID: 'ws-1', status: 'connected' },
        },
      })
    ).toEqual({
      type: 'server/event',
      payload: {
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      },
    });

    expect(
      parseExtensionMessage({
        type: 'server/event',
        payload: { type: 'totally.unknown', properties: { a: 1 } },
      })
    ).toBeNull();
  });

  it('parses terminal-selection/update null and object payloads', () => {
    expect(parseExtensionMessage({ type: 'terminal-selection/update', payload: null })).toEqual({
      type: 'terminal-selection/update',
      payload: null,
    });

    expect(
      parseExtensionMessage({
        type: 'terminal-selection/update',
        payload: { text: 'ls', terminalName: 'zsh' },
      })
    ).toEqual({
      type: 'terminal-selection/update',
      payload: { text: 'ls', terminalName: 'zsh' },
    });

    expect(
      parseExtensionMessage({ type: 'terminal-selection/update', payload: { text: 'ls' } })
    ).toBeNull();
  });

  it('rejects malformed context/update payloads', () => {
    expect(
      parseExtensionMessage({
        type: 'context/update',
        payload: {
          workspacePath: '/repo',
          activeFile: { path: '/repo/src/app.ts', relativePath: 'src/app.ts', language: 'ts' },
          selection: { startLine: 1, endLine: 3 },
          diagnostics: [{ path: '/repo/src/app.ts', severity: 'error', message: 'bad', line: 1 }],
        },
      })
    ).toEqual({
      type: 'context/update',
      payload: {
        workspacePath: '/repo',
        activeFile: { path: '/repo/src/app.ts', relativePath: 'src/app.ts', language: 'ts' },
        selection: { startLine: 1, endLine: 3 },
        diagnostics: [{ path: '/repo/src/app.ts', severity: 'error', message: 'bad', line: 1 }],
      },
    });

    expect(
      parseExtensionMessage({
        type: 'context/update',
        payload: { workspacePath: '/repo', activeFile: { path: '/repo/src/app.ts' } },
      })
    ).toBeNull();

    expect(
      parseExtensionMessage({
        type: 'context/update',
        payload: {
          workspacePath: null,
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      })
    ).toEqual({
      type: 'context/update',
      payload: {
        workspacePath: null,
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    });
  });

  it('rejects malformed dropped file payloads', () => {
    expect(
      parseExtensionMessage({
        type: 'files/dropped',
        payload: [
          { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
          {
            path: '/repo/src/lib.ts',
            relativePath: 'src/lib.ts',
            type: 'file',
            lineRanges: [{ startLine: 3, endLine: 8 }],
          },
        ],
      })
    ).toEqual({
      type: 'files/dropped',
      payload: [
        { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
        {
          path: '/repo/src/lib.ts',
          relativePath: 'src/lib.ts',
          type: 'file',
          lineRanges: [{ startLine: 3, endLine: 8 }],
        },
      ],
    });

    expect(
      parseExtensionMessage({
        type: 'files/dropped',
        payload: [{ path: '/repo/src/app.ts', type: 'file' }],
      })
    ).toBeNull();

    expect(
      parseExtensionMessage({
        type: 'files/dropped',
        payload: [{ path: '/repo/src', relativePath: 'src', type: 'directory' }],
      })
    ).toEqual({
      type: 'files/dropped',
      payload: [{ path: '/repo/src', relativePath: 'src', type: 'directory' }],
    });
  });

  it('parses files/removed with a path and rejects malformed payloads', () => {
    expect(
      parseExtensionMessage({ type: 'files/removed', payload: { path: '/repo/src/app.ts' } })
    ).toEqual({
      type: 'files/removed',
      payload: { path: '/repo/src/app.ts' },
    });

    expect(parseExtensionMessage({ type: 'files/removed', payload: {} })).toBeNull();
  });

  it('rejects malformed files/search-results payloads', () => {
    expect(
      parseExtensionMessage({
        type: 'files/search-results',
        payload: {
          requestId: 1,
          query: 'app',
          files: [{ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' }],
        },
      })
    ).toEqual({
      type: 'files/search-results',
      payload: {
        requestId: 1,
        query: 'app',
        files: [{ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' }],
      },
    });

    expect(
      parseExtensionMessage({
        type: 'files/search-results',
        payload: {
          requestId: 1,
          query: 'app',
          files: [{ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'weird' }],
        },
      })
    ).toBeNull();

    expect(
      parseExtensionMessage({
        type: 'files/search-results',
        payload: {
          requestId: 2,
          query: 'src',
          files: [{ path: '/repo/src', relativePath: 'src', type: 'directory' }],
        },
      })
    ).toEqual({
      type: 'files/search-results',
      payload: {
        requestId: 2,
        query: 'src',
        files: [{ path: '/repo/src', relativePath: 'src', type: 'directory' }],
      },
    });
  });

  it('rejects malformed theme/update payloads', () => {
    expect(parseExtensionMessage({ type: 'theme/update', payload: { theme: 'dark' } })).toEqual({
      type: 'theme/update',
      payload: { theme: 'dark' },
    });
    expect(
      parseExtensionMessage({ type: 'theme/update', payload: { theme: 'high-contrast-light' } })
    ).toEqual({
      type: 'theme/update',
      payload: { theme: 'high-contrast-light' },
    });

    expect(
      parseExtensionMessage({ type: 'theme/update', payload: { theme: 'neon-future' } })
    ).toBeNull();
  });

  it('parses config/update with strict payload', () => {
    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          showStickyUserPrompt: false,
          desktopSessionPaneSide: 'left',
          defaultPermissionMode: 'full',
          providerLimitPollIntervalSeconds: 120,
          providerLimitsDisabled: false,
          providerLimitThresholdPercent: 35,
        },
      })
    ).toEqual({
      type: 'config/update',
      payload: {
        expandThinkingByDefault: true,
        showStickyUserPrompt: false,
        desktopSessionPaneSide: 'left',
        defaultPermissionMode: 'full',
        providerLimitPollIntervalSeconds: 120,
        providerLimitsDisabled: false,
        providerLimitThresholdPercent: 35,
      },
    });

    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: { expandThinkingByDefault: true, showStickyUserPrompt: false },
      })
    ).toBeNull();
  });

  it('parses disabled provider-limit polling in config/update', () => {
    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          showStickyUserPrompt: false,
          desktopSessionPaneSide: 'left',
          defaultPermissionMode: 'default',
          providerLimitsDisabled: true,
        },
      })
    ).toEqual({
      type: 'config/update',
      payload: {
        expandThinkingByDefault: true,
        showStickyUserPrompt: false,
        desktopSessionPaneSide: 'left',
        defaultPermissionMode: 'default',
        providerLimitsDisabled: true,
      },
    });
  });

  it('maps legacy disabled provider-limit polling payloads to the boolean flag', () => {
    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: {
          expandThinkingByDefault: true,
          showStickyUserPrompt: false,
          desktopSessionPaneSide: 'left',
          defaultPermissionMode: 'default',
          providerLimitPollIntervalSeconds: -1,
        },
      })
    ).toEqual({
      type: 'config/update',
      payload: {
        expandThinkingByDefault: true,
        showStickyUserPrompt: false,
        desktopSessionPaneSide: 'left',
        defaultPermissionMode: 'default',
        providerLimitPollIntervalSeconds: -1,
        providerLimitsDisabled: true,
      },
    });
  });
});
