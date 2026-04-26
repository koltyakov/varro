import { describe, expect, it } from 'vitest';
import { isAllowedApiRequest, parseWebviewMessage } from './webview-message';

describe('webview message validation', () => {
  it('accepts known API routes used by the webview client', () => {
    expect(isAllowedApiRequest('GET', '/command')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/init')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/prompt_async')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/command')).toBe(true);
    expect(isAllowedApiRequest('GET', '/session/abc/diff?messageID=msg-1')).toBe(true);
    expect(isAllowedApiRequest('POST', '/session/abc/unrevert')).toBe(true);
    expect(isAllowedApiRequest('POST', '/question/request-1/reply')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/provider-limit?providerID=openai')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/opencode-config')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/opencode-config/model-routing')).toBe(true);
    expect(isAllowedApiRequest('GET', '/varro/session-trash')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/session-trash/session-1/restore')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash/session-1/delete')).toBe(true);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash')).toBe(true);
    expect(isAllowedApiRequest('POST', '/varro/plan/open')).toBe(true);
    expect(isAllowedApiRequest('GET', '/mcp')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/connect')).toBe(true);
    expect(isAllowedApiRequest('POST', '/mcp/browser-bridge/disconnect')).toBe(true);
  });

  it('rejects absolute and unsupported API routes', () => {
    expect(isAllowedApiRequest('GET', 'https://example.com/session')).toBe(false);
    expect(isAllowedApiRequest('GET', '//example.com/session')).toBe(false);
    expect(isAllowedApiRequest('GET', '/experimental/console')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/config/providers')).toBe(false);
    expect(isAllowedApiRequest('GET', '/session/abc/diff?messageID=1&extra=1')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/provider-limit?modelID=gpt')).toBe(false);
    expect(isAllowedApiRequest('POST', '/varro/opencode-config')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/opencode-config/model-routing')).toBe(false);
    expect(isAllowedApiRequest('GET', '/varro/plan/open')).toBe(false);
    expect(isAllowedApiRequest('POST', '/varro/session-trash/session-1/delete')).toBe(false);
    expect(isAllowedApiRequest('DELETE', '/varro/session-trash/session-1/restore')).toBe(false);
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

  it('accepts session export messages with a valid session id', () => {
    expect(
      parseWebviewMessage({ type: 'session/export', payload: { sessionId: 'session-1' } })
    ).toEqual({
      type: 'session/export',
      payload: { sessionId: 'session-1' },
    });

    expect(parseWebviewMessage({ type: 'session/export', payload: {} })).toBeNull();
  });
});
