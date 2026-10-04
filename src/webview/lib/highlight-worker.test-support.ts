import { vi } from 'vitest';
import { hasLanguage, highlightCode } from './syntax-highlighter';
import { codeHighlighter, resolveCodeLanguage } from './code-highlighter';
import type { HighlightRequest, HighlightResponse } from './highlight-protocol';

// jsdom has no Worker. Browser tests exercise the real bundled worker; component
// tests use the same engine behind an asynchronous message boundary.
export function installHighlightWorker(): void {
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      private stopped = false;
      constructor() {
        setTimeout(() => this.emit({ ready: true }), 0);
      }
      private emit(data: HighlightResponse | { ready: true }) {
        if (!this.stopped) this.onmessage?.(new MessageEvent('message', { data }));
      }
      postMessage(request: HighlightRequest) {
        setTimeout(
          () =>
            this.emit({
              id: request.id,
              html: hasLanguage(request.language)
                ? highlightCode(request.text, request.language)
                : null,
            }),
          0
        );
      }
      terminate() {
        this.stopped = true;
      }
    }
  );
}

export function requestHighlight(text: string, language: string): Promise<string | null> {
  return new Promise((resolve) =>
    codeHighlighter.request(text, resolveCodeLanguage(language)!, resolve)
  );
}
