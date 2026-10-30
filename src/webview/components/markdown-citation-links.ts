import { citationPathChecks } from '../lib/citation-path-checks';
import type { CitationPathChecks, CitationPathScope } from '../lib/citation-path-checks';
import { getLinkContext } from '../lib/link-context';
import { asRecord, getString, isNumber } from '../lib/runtime-values';

/** Bind already-sanitized citation candidates without reparsing streamed Markdown. */
export class MarkdownCitationLinks {
  private disposed = false;

  constructor(
    private readonly onValidated: (anchor: HTMLAnchorElement) => void,
    private readonly checks: CitationPathChecks = citationPathChecks
  ) {}

  hydrate(root: HTMLElement | undefined, scope: CitationPathScope): void {
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
  }

  dispose(): void {
    this.disposed = true;
  }
}
