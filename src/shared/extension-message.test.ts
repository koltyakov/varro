import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from './extension-message';

describe('parseExtensionMessage', () => {
  it('parses persisted session plan and agent state', () => {
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/sync',
        payload: { state: { 'session-1': 200 }, agents: { 'session-1': 'build' } },
      })
    ).toEqual({
      type: 'session-plan-state/sync',
      payload: { state: { 'session-1': 200 }, agents: { 'session-1': 'build' } },
    });
  });

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
    expect(
      parseExtensionMessage({
        type: 'command/new-session',
        payload: { prefill: '/init' },
      })
    ).toEqual({ type: 'command/new-session', payload: { prefill: '/init' } });
    expect(
      parseExtensionMessage({ type: 'command/new-session', payload: { prefill: 1 } })
    ).toBeNull();
    expect(
      parseExtensionMessage({ type: 'command/open-session', payload: { sessionId: 'session-1' } })
    ).toEqual({ type: 'command/open-session', payload: { sessionId: 'session-1' } });
    expect(
      parseExtensionMessage({ type: 'command/open-session', payload: { sessionId: 1 } })
    ).toBeNull();
    expect(parseExtensionMessage({ type: 'command/focus-input' })).toEqual({
      type: 'command/focus-input',
    });
    expect(parseExtensionMessage({ type: 'command/search-sessions' })).toEqual({
      type: 'command/search-sessions',
    });
    expect(parseExtensionMessage({ type: 'command/open-attention-sessions' })).toEqual({
      type: 'command/open-attention-sessions',
    });
    expect(parseExtensionMessage({ type: 'command/open-completed-sessions' })).toEqual({
      type: 'command/open-completed-sessions',
    });
    expect(
      parseExtensionMessage({
        type: 'command/switch-session',
        payload: { direction: 'previous' },
      })
    ).toEqual({ type: 'command/switch-session', payload: { direction: 'previous' } });
    expect(
      parseExtensionMessage({ type: 'command/switch-session', payload: { direction: 'sideways' } })
    ).toBeNull();
    expect(parseExtensionMessage({ type: 'command/abort' })).toEqual({ type: 'command/abort' });
  });

  it('parses provider refresh re-validation requests', () => {
    expect(parseExtensionMessage({ type: 'providers/refresh' })).toEqual({
      type: 'providers/refresh',
    });
    expect(
      parseExtensionMessage({
        type: 'providers/refresh',
        payload: { revalidateAuth: true },
      })
    ).toEqual({ type: 'providers/refresh', payload: { revalidateAuth: true } });
    expect(
      parseExtensionMessage({
        type: 'providers/refresh',
        payload: { revalidateAuth: false },
      })
    ).toBeNull();
  });

  it('parses provider refresh status', () => {
    expect(parseExtensionMessage({ type: 'providers/status', payload: { pending: true } })).toEqual(
      { type: 'providers/status', payload: { pending: true } }
    );
    expect(
      parseExtensionMessage({ type: 'providers/status', payload: { pending: false } })
    ).toEqual({ type: 'providers/status', payload: { pending: false } });
    expect(
      parseExtensionMessage({ type: 'providers/status', payload: { pending: 'yes' } })
    ).toBeNull();
  });

  it('parses VS Code open results', () => {
    expect(
      parseExtensionMessage({
        type: 'vscode/open-result',
        payload: { requestId: 7, status: 'unavailable' },
      })
    ).toEqual({
      type: 'vscode/open-result',
      payload: { requestId: 7, status: 'unavailable' },
    });
    expect(
      parseExtensionMessage({
        type: 'vscode/open-result',
        payload: { requestId: '7', status: 'missing' },
      })
    ).toBeNull();
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

  it('parses restart blockers only when directory counts match the total', () => {
    const message = {
      type: 'server/restart-blocked',
      payload: {
        totalSessionCount: 3,
        directories: [
          { directory: '/repo-a', sessionCount: 2 },
          { directory: null, sessionCount: 1 },
        ],
      },
    };

    expect(parseExtensionMessage(message)).toEqual(message);
    expect(
      parseExtensionMessage({
        ...message,
        payload: { ...message.payload, totalSessionCount: 4 },
      })
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

  it('parses host queue synchronization snapshots', () => {
    const message = {
      type: 'queued-messages/sync',
      payload: {
        messages: [
          {
            id: 'queue-1',
            ownerViewId: 'sidebar',
            sessionId: 'session-1',
            text: 'Continue',
            droppedFiles: [],
            clipboardImages: [],
            terminalSelection: null,
          },
        ],
      },
    } as const;

    expect(parseExtensionMessage(message)).toEqual(message);
  });

  it('parses host permission mode snapshots', () => {
    const message = {
      type: 'permission-modes/sync',
      payload: { modes: { 'session-1': 'full' } },
    } as const;

    expect(parseExtensionMessage(message)).toEqual(message);
    expect(
      parseExtensionMessage({
        type: 'permission-modes/sync',
        payload: { modes: { 'session-1': 'invalid' } },
      })
    ).toBeNull();
  });

  it('parses host session model snapshots with reasoning variants', () => {
    const message = {
      type: 'session-models/sync',
      payload: {
        models: {
          'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
        },
      },
    } as const;

    expect(parseExtensionMessage(message)).toEqual(message);
    expect(
      parseExtensionMessage({
        type: 'session-models/sync',
        payload: { models: { 'session-1': { providerID: 'openai', modelID: 1 } } },
      })
    ).toBeNull();
  });

  it.each(['__proto__', 'constructor', 'prototype', 'x'.repeat(513)])(
    'rejects unsafe persisted session ID %s in host snapshots',
    (sessionId) => {
      expect(
        parseExtensionMessage({
          type: 'permission-modes/sync',
          payload: { modes: { [sessionId]: 'full' } },
        })
      ).toBeNull();
      expect(
        parseExtensionMessage({
          type: 'session-models/sync',
          payload: {
            models: { [sessionId]: { providerID: 'openai', modelID: 'gpt-5.6-sol' } },
          },
        })
      ).toBeNull();
    }
  );

  it('parses editor-tab lifecycle state', () => {
    expect(
      parseExtensionMessage({
        type: 'editor-tabs/state',
        payload: { open: true, sessionIds: ['session-1'] },
      })
    ).toEqual({
      type: 'editor-tabs/state',
      payload: { open: true, sessionIds: ['session-1'] },
    });
    expect(
      parseExtensionMessage({ type: 'editor-tabs/state', payload: { open: 'yes' } })
    ).toBeNull();
  });

  it('parses sibling workspace alert updates', () => {
    expect(
      parseExtensionMessage({
        type: 'sibling-workspace-alerts/update',
        payload: [
          {
            name: 'Repo B',
            path: '/repo-b',
            kinds: ['attention', 'error', 'plan-ready'],
            count: 2,
          },
        ],
      })
    ).toEqual({
      type: 'sibling-workspace-alerts/update',
      payload: [
        {
          name: 'Repo B',
          path: '/repo-b',
          kinds: ['attention', 'error', 'plan-ready'],
          count: 2,
        },
      ],
    });
    expect(
      parseExtensionMessage({
        type: 'sibling-workspace-alerts/update',
        payload: [{ name: 'Repo B', path: '/repo-b', kinds: ['completed'], count: 1 }],
      })
    ).toBeNull();
  });

  it('parses permission ownership and recovery updates', () => {
    expect(
      parseExtensionMessage({
        type: 'permission-automation/update',
        payload: { owner: true, lease: 3 },
      })
    ).toEqual({
      type: 'permission-automation/update',
      payload: { owner: true, lease: 3 },
    });
    expect(
      parseExtensionMessage({
        type: 'permission/actionable',
        payload: { permissionId: 'perm-1' },
      })
    ).toEqual({ type: 'permission/actionable', payload: { permissionId: 'perm-1' } });
    expect(
      parseExtensionMessage({
        type: 'recovery/interrupted-sessions',
        payload: { claimId: 3, sessionIds: ['session-1', 'session-1'] },
      })
    ).toEqual({
      type: 'recovery/interrupted-sessions',
      payload: { claimId: 3, sessionIds: ['session-1'] },
    });
  });

  it('parses Ralph migration acknowledgements and rejects malformed markers', () => {
    const run = {
      config: {
        managerSessionId: 'manager-1',
        workspaceDirectory: '/workspace',
        planDocPath: 'RALPH.md',
        iterations: 1,
        promptTemplate: 'Prompt',
        permissionMode: 'full',
        model: null,
        agent: null,
        createdAt: 1,
      },
      status: 'paused',
      currentIteration: 0,
      iterations: [],
      updatedAt: 1,
    } as const;

    expect(
      parseExtensionMessage({
        type: 'ralph/state',
        payload: {
          runs: { 'manager-1': { ...run, legacyMigrationAcknowledged: true } },
          activeIds: [],
        },
      })
    ).toEqual({
      type: 'ralph/state',
      payload: {
        runs: { 'manager-1': { ...run, legacyMigrationAcknowledged: true } },
        activeIds: [],
      },
    });
    expect(
      parseExtensionMessage({
        type: 'ralph/state',
        payload: {
          runs: { 'manager-1': { ...run, legacyMigrationAcknowledged: 'yes' } },
          activeIds: [],
        },
      })
    ).toBeNull();
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

    expect(
      parseExtensionMessage({
        type: 'context/update',
        payload: {
          workspacePath: '/repo',
          activeWorkspacePath: 42,
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
      })
    ).toBeNull();
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

  it('parses valid picked PDFs and rejects malformed payloads', () => {
    const pdf = {
      id: 'pdf-1',
      url: 'data:application/pdf;base64,JVBERi0xCg==',
      mime: 'application/pdf',
      filename: 'spec.pdf',
      size: 7,
    };

    expect(parseExtensionMessage({ type: 'pdfs/picked', payload: [pdf] })).toEqual({
      type: 'pdfs/picked',
      payload: [pdf],
    });
    expect(
      parseExtensionMessage({
        type: 'pdfs/picked',
        payload: [{ ...pdf, url: 'data:application/pdf;base64,bm90IGEgcGRm' }],
      })
    ).toBeNull();
    expect(parseExtensionMessage({ type: 'pdfs/picked', payload: {} })).toBeNull();

    expect(
      parseExtensionMessage({
        type: 'pdfs/stored',
        payload: {
          id: 'pdf-1',
          contextFile: { path: '/tmp/spec.pdf', relativePath: 'spec.pdf', type: 'file' },
        },
      })
    ).toEqual({
      type: 'pdfs/stored',
      payload: {
        id: 'pdf-1',
        contextFile: { path: '/tmp/spec.pdf', relativePath: 'spec.pdf', type: 'file' },
      },
    });

    expect(
      parseExtensionMessage({
        type: 'images/stored',
        payload: {
          id: 'image-1',
          contextFile: { path: '/tmp/image.png', relativePath: 'image.png', type: 'file' },
        },
      })
    ).toEqual({
      type: 'images/stored',
      payload: {
        id: 'image-1',
        contextFile: { path: '/tmp/image.png', relativePath: 'image.png', type: 'file' },
      },
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
          showFileDiffs: true,
          expandThinking: true,
          showChangedFiles: true,
          desktopSessionPaneSide: 'left',
          defaultPermissionMode: 'full',
          chatFontSize: 13,
          chatEditorFontSize: 12,
          chatFontFamily: 'default',
        },
      })
    ).toEqual({
      type: 'config/update',
      payload: {
        showFileDiffs: true,
        expandThinking: true,
        showChangedFiles: true,
        desktopSessionPaneSide: 'left',
        defaultPermissionMode: 'full',
        chatFontSize: 13,
        chatEditorFontSize: 12,
        chatFontFamily: 'default',
      },
    });

    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: { desktopSessionPaneSide: 'left' },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: {
          desktopSessionPaneSide: 'bottom',
          defaultPermissionMode: 'full',
          chatFontSize: 13,
          chatEditorFontSize: 12,
          chatFontFamily: 'default',
        },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: {
          desktopSessionPaneSide: 'left',
          defaultPermissionMode: 'invalid',
          chatFontSize: 13,
          chatEditorFontSize: 12,
          chatFontFamily: 'default',
        },
      })
    ).toBeNull();
    for (const chatFontSize of [5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseExtensionMessage({
          type: 'config/update',
          payload: {
            desktopSessionPaneSide: 'left',
            defaultPermissionMode: 'full',
            chatFontSize,
            chatEditorFontSize: 12,
            chatFontFamily: 'default',
          },
        })
      ).toBeNull();
    }
    for (const chatEditorFontSize of [5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseExtensionMessage({
          type: 'config/update',
          payload: {
            desktopSessionPaneSide: 'left',
            defaultPermissionMode: 'full',
            chatFontSize: 13,
            chatEditorFontSize,
            chatFontFamily: 'default',
          },
        })
      ).toBeNull();
    }
  });

  it('parses auto permission mode in config/update', () => {
    expect(
      parseExtensionMessage({
        type: 'config/update',
        payload: {
          desktopSessionPaneSide: 'left',
          defaultPermissionMode: 'auto',
          chatFontSize: 13,
          chatEditorFontSize: 12,
          chatFontFamily: 'default',
        },
      })
    ).toEqual({
      type: 'config/update',
      payload: {
        desktopSessionPaneSide: 'left',
        defaultPermissionMode: 'auto',
        chatFontSize: 13,
        chatEditorFontSize: 12,
        chatFontFamily: 'default',
      },
    });
  });
});

describe('parseExtensionMessage queued message claim results', () => {
  const base = { requestId: 1, itemId: 'queued-1', sessionId: 'session-1' };

  it('parses a granted claim carrying its lease', () => {
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, granted: true, lease: 9 },
      })
    ).toEqual({
      type: 'queued-messages/claim-result',
      payload: {
        requestId: 1,
        itemId: 'queued-1',
        sessionId: 'session-1',
        granted: true,
        lease: 9,
      },
    });
  });

  it('parses a refused claim with no lease', () => {
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, granted: false },
      })
    ).toEqual({
      type: 'queued-messages/claim-result',
      payload: { requestId: 1, itemId: 'queued-1', sessionId: 'session-1', granted: false },
    });
  });

  it('rejects a granted claim without a lease', () => {
    // A grant is the mutual-exclusion token for dispatching a queued message.
    // Accepting one without a lease would let two windows both believe they own it.
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, granted: true },
      })
    ).toBeNull();
  });

  it('rejects a refused claim that still carries a lease', () => {
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, granted: false, lease: 9 },
      })
    ).toBeNull();
  });

  it('rejects malformed leases on a granted claim', () => {
    for (const lease of [0, -1, 1.5, '9', null, Number.NaN]) {
      expect(
        parseExtensionMessage({
          type: 'queued-messages/claim-result',
          payload: { ...base, granted: true, lease },
        })
      ).toBeNull();
    }
  });

  it('rejects malformed identity and request fields', () => {
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, requestId: -1, granted: false },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, requestId: 1.5, granted: false },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, itemId: 7, granted: false },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, sessionId: null, granted: false },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, granted: 'yes' },
      })
    ).toBeNull();
    expect(parseExtensionMessage({ type: 'queued-messages/claim-result' })).toBeNull();
  });

  it('accepts requestId 0 as the first request of a session', () => {
    expect(
      parseExtensionMessage({
        type: 'queued-messages/claim-result',
        payload: { ...base, requestId: 0, granted: false },
      })
    ).toMatchObject({ payload: { requestId: 0 } });
  });
});

describe('parseExtensionMessage queued session status', () => {
  it('parses busy and idle queue lifecycle updates', () => {
    for (const status of ['busy', 'idle'] as const) {
      expect(
        parseExtensionMessage({
          type: 'queued-messages/session-status',
          payload: { sessionId: 'session-1', status },
        })
      ).toEqual({
        type: 'queued-messages/session-status',
        payload: { sessionId: 'session-1', status },
      });
    }
  });

  it('rejects malformed queue lifecycle updates', () => {
    expect(
      parseExtensionMessage({
        type: 'queued-messages/session-status',
        payload: { sessionId: 'session-1', status: 'retry' },
      })
    ).toBeNull();
  });
});

describe('parseExtensionMessage plan state and model preference syncs', () => {
  it('parses a plan-state update carrying a skip time', () => {
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', skippedAt: 200 },
      })
    ).toEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', skippedAt: 200 },
    });
  });

  it('parses a plan-state update carrying only an agent', () => {
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', agent: 'plan' },
      })
    ).toEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', agent: 'plan' },
    });
  });

  it('preserves an explicit null skip time that clears the skip', () => {
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', skippedAt: null },
      })
    ).toEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', skippedAt: null },
    });
  });

  it('rejects a plan-state update that changes nothing', () => {
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1' },
      })
    ).toBeNull();
  });

  it('rejects malformed plan-state updates', () => {
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: '', skippedAt: 1 },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: '__proto__', skippedAt: 1 },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', skippedAt: Number.NaN },
      })
    ).toBeNull();
    expect(
      parseExtensionMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', agent: '  ' },
      })
    ).toBeNull();
  });

  it('parses a model preference sync and rejects a non-object payload', () => {
    const preferences = {
      modelVariantSelections: { 'anthropic/claude-opus-5': 'thinking' },
      hiddenProviders: ['openai'],
      hiddenModels: [],
      addedModels: [],
      pinnedModels: [],
      modelDisplayNames: {},
    };

    expect(parseExtensionMessage({ type: 'model-preferences/sync', payload: preferences })).toEqual(
      { type: 'model-preferences/sync', payload: preferences }
    );
    expect(parseExtensionMessage({ type: 'model-preferences/sync' })).toBeNull();
    expect(parseExtensionMessage({ type: 'model-preferences/sync', payload: [] })).toBeNull();
  });
});
