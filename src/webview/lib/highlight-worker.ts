/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated worker messages have no targetOrigin. */
import { canHighlight, MAX_HIGHLIGHT_OUTPUT_CHARACTERS } from './highlight-protocol';
import type { HighlightRequest, HighlightResponse } from './highlight-protocol';
import { hasLanguage, highlightCode } from './syntax-highlighter';

// A narrow worker global avoids mixing lib.dom and lib.webworker declarations.
declare const self: {
  addEventListener: (
    type: 'message',
    callback: (event: MessageEvent<HighlightRequest>) => void
  ) => void;
  postMessage: (response: HighlightResponse | { ready: true }) => void;
};
self.addEventListener('message', ({ data }) => {
  let html: string | null = null;
  try {
    if (canHighlight(data.text) && hasLanguage(data.language)) {
      const result = highlightCode(data.text, data.language);
      if (result.length <= MAX_HIGHLIGHT_OUTPUT_CHARACTERS) html = result;
    }
  } catch {
    // Highlighting is optional. Preserve plaintext for unsupported or invalid input.
  }
  self.postMessage({ id: data.id, html });
});
self.postMessage({ ready: true });
