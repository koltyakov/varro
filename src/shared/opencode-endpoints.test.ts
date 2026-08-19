import { describe, expect, it } from 'vitest';
import { CURRENT_OPENCODE_ENDPOINTS, parseSessionPromptEndpoint } from './opencode-endpoints';

describe('OpenCode endpoints', () => {
  it('builds the currently supported wire paths', () => {
    expect(CURRENT_OPENCODE_ENDPOINTS.health).toBe('/global/health');
    expect(CURRENT_OPENCODE_ENDPOINTS.eventStream).toBe('/global/event');
    expect(CURRENT_OPENCODE_ENDPOINTS.sessionPromptAsync('session / one')).toBe(
      '/session/session%20%2F%20one/prompt_async'
    );
  });

  it('recognizes legacy and current prompt spellings', () => {
    expect(parseSessionPromptEndpoint('/session/session%201/prompt_async?directory=/repo')).toBe(
      'session 1'
    );
    expect(parseSessionPromptEndpoint('/session/session-2/prompt')).toBe('session-2');
    expect(parseSessionPromptEndpoint('/session/session-2/message')).toBeNull();
  });
});
