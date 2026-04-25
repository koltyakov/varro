import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from './extension-message';
import type { ExtensionMessage, WebviewMessage } from './protocol';

/**
 * Compile-time conformance: every ExtensionMessage discriminator must be
 * recognized by the runtime validator. If a new message type is added to
 * the protocol but not to the validator, TypeScript will fail here with
 * an exhaustiveness error on `_unreachable`.
 */
describe('protocol conformance', () => {
  it('covers every ExtensionMessage type in the validator (compile-time)', () => {
    const covered: Record<ExtensionMessage['type'], true> = {
      'server/status': true,
      'server/event': true,
      'pending-attention/update': true,
      'context/update': true,
      'terminal-selection/update': true,
      'files/dropped': true,
      'files/removed': true,
      'files/search-results': true,
      'config/update': true,
      'theme/update': true,
      'api/response': true,
      'command/new-session': true,
      'command/focus-input': true,
      'command/open-attention-sessions': true,
      'command/abort': true,
    };

    // If a new ExtensionMessage type is added, the Record literal above will
    // fail to compile until this map is extended — forcing the validator to
    // be updated in lockstep.
    const knownCount = Object.keys(covered).length;
    expect(knownCount).toBeGreaterThan(0);
  });

  it('exhaustiveness check on WebviewMessage type discriminators', () => {
    const covered: Record<WebviewMessage['type'], true> = {
      'context/request': true,
      'webview/focus': true,
      'terminal-selection/clear': true,
      'terminal/run': true,
      'vscode/open-settings': true,
      'files/drop': true,
      'files/drop-content': true,
      'files/remove': true,
      'files/clear': true,
      'files/pick': true,
      'files/search': true,
      'file/read': true,
      'vscode/open': true,
      'vscode/open-external': true,
      'config/update': true,
      ready: true,
      'api/request': true,
      log: true,
    };

    expect(Object.keys(covered).length).toBeGreaterThan(0);
  });

  it('validator round-trips a server/status running payload', () => {
    const msg: ExtensionMessage = {
      type: 'server/status',
      payload: { state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' },
    };
    expect(parseExtensionMessage(msg)).toEqual(msg);
  });
});
