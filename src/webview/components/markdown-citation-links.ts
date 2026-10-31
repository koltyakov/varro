import { citationPathChecks } from '../lib/citation-path-checks';
import { citationSymbolLookups } from '../lib/citation-symbol-checks';
import type { CitationPathChecks, CitationPathScope } from '../lib/citation-path-checks';
import { parseCitationSymbol } from '../../shared/citation-symbol';
import type { CitationSymbolTarget } from '../../shared/citation-symbol';
import { getLinkContext } from '../lib/link-context';
import { asRecord, getString, isNumber } from '../lib/runtime-values';

/** Bind already-sanitized citation candidates without reparsing streamed Markdown. */
export class MarkdownCitationLinks {
  private disposed = false;
  private readonly symbolCodes = new WeakSet<HTMLElement>();

  constructor(
    private readonly onValidated: (anchor: HTMLAnchorElement) => void,
    private readonly checks: CitationPathChecks = citationPathChecks
  ) {}

  hydrate(root: HTMLElement | undefined, scope: CitationPathScope, inferSymbols = true): void {
    if (!root || this.disposed) return;
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[data-file]')) {
      if (anchor.dataset.fileValidated === 'true') continue;
      let payload: ReturnType<typeof asRecord> = null;
      try {
        payload = asRecord(JSON.parse(anchor.dataset.file ?? ''));
      } catch {
        // A malformed candidate is never actionable.
      }
      const path = getString(payload?.path);
      const activate = (absolutePath: string) => {
        const line = payload?.line;
        const endLine = payload?.endLine;
        const suffix = isNumber(line) ? `:${line}${isNumber(endLine) ? `-${endLine}` : ''}` : '';
        anchor.href = `${absolutePath}${suffix}`;
        anchor.title = `${absolutePath}${suffix}`;
        anchor.dataset.file = JSON.stringify({ ...payload, path: absolutePath });
        anchor.dataset.fileValidated = 'true';
        anchor.setAttribute(
          'data-vscode-context',
          getLinkContext(anchor.textContent ?? '', { path: absolutePath })
        );
      };
      const cached = path ? this.checks.peek(path, scope) : null;
      if (cached) {
        activate(cached);
        continue;
      }
      const code = document.createElement('code');
      code.className = 'citation-path';
      code.append(...anchor.childNodes);
      anchor.replaceWith(code);
      if (cached === null || !path) continue;
      void this.checks.check(path, scope).then((absolutePath) => {
        if (this.disposed || !absolutePath || !code.isConnected) return;
        anchor.append(...code.childNodes);
        activate(absolutePath);
        code.replaceWith(anchor);
        this.onValidated(anchor);
      });
    }
    if (inferSymbols) this.hydrateSymbols(root, scope);
  }

  private hydrateSymbols(root: HTMLElement, scope: CitationPathScope): void {
    for (const code of root.querySelectorAll<HTMLElement>('code[data-citation-symbol]')) {
      if (
        code.closest('pre, a, button, .katex, .citation-path') ||
        this.symbolCodes.has(code) ||
        !parseCitationSymbol(code.textContent ?? '')
      )
        continue;
      this.symbolCodes.add(code);
      const text = code.textContent ?? '';
      const activate = (target: CitationSymbolTarget) => {
        if (this.disposed) return;
        const anchor = document.createElement('a');
        anchor.className = 'file-path-link';
        anchor.href = `${target.path}:${target.line}`;
        anchor.title = `${target.path}:${target.line}`;
        anchor.dataset.file = JSON.stringify(target);
        anchor.dataset.fileValidated = 'true';
        anchor.setAttribute('data-vscode-context', getLinkContext(text, { path: target.path }));
        // Retain the code node and label, including its metrics, instead of adding a file icon.
        code.replaceWith(anchor);
        anchor.append(code);
        this.onValidated(anchor);
      };
      const cached = citationSymbolLookups.peek(text, scope);
      if (cached) activate(cached);
      else if (cached !== null) {
        // Slow or busy providers are retried by the shared chain; this node is never rehydrated.
        void citationSymbolLookups.resolve(text, scope, code).then((target) => {
          if (target && code.isConnected) activate(target);
        });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
