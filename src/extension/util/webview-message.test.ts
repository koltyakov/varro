import { describe, expect, it } from 'vitest';
import { isAllowedApiRequest, isAllowedExternalUrl, parseWebviewMessage } from './webview-message';

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
    expect(isAllowedApiRequest('DELETE', '/varro/session/session-1/delete')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/session-trash')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/session-trash/session-1/restore')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash/session-1/delete')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/plan/open')).toBe(true);
    expect(isAllowedApiRequest('GET', '/mcp')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/connect')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/disconnect')).toBe(true);
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
    expect(isAllowedApiRequest('POST', '/session/abc/message?limit=5')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/provider-limit?modelID=gpt')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/workspace-file')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/workspace-path/resolve')).toBe(false);
    expect(isAllowedApiRequest('POST', '/varro/opencode-config')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/opencode-config/model-routing')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/permission/judge')).toBe(false);
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
          files: [{ name: 'note.txt', content: 'Zm9v', size: 25 * 1024 * 1024 + 1 }],
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
          column: 7,
          selection: { startLine: 12, endLine: 14 },
        },
      })
    ).toEqual({
      type: 'vscode/open',
      payload: { path: '/repo/src/app.ts', line: 12, kind: 'file' },
    });
  });

  it('rejects malformed URLs and unsafe path traversal in helper guards', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/../message')).toBe(false);
    expect(isAllowedApiRequest('POST', '/mcp/%2F/connect')).toBe(false);
  });
});
