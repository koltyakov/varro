import { codeHighlighter, resolveCodeLanguage } from './code-highlighter';

// The element and source together are the ownership token. Replaced renderer roots cannot
// receive old results, even when their message/part IDs are reused after a session switch.
export class CodeHighlightBinding {
  private readonly pending = new Map<
    HTMLElement,
    { text: string; language: string; cancel: () => void }
  >();

  reconcile(roots: readonly (HTMLElement | undefined)[], priority = 0): void {
    for (const [element, job] of this.pending) {
      if (!roots.some((root) => root?.contains(element))) {
        job.cancel();
        this.pending.delete(element);
      }
    }
    for (const root of roots) {
      if (!root) continue;
      this.add(root, priority);
    }
  }

  add(root: HTMLElement, priority = 0): void {
    for (const element of root.querySelectorAll<HTMLElement>('[data-highlight-lang]')) {
      const language = resolveCodeLanguage(element.dataset.highlightLang);
      if (!language) continue;
      const text = element.textContent ?? '';
      const previous = this.pending.get(element);
      if (previous?.text === text && previous.language === language) continue;
      previous?.cancel();
      const job = { text, language, cancel: () => {} };
      this.pending.set(element, job);
      job.cancel = codeHighlighter.request(
        text,
        language,
        (html) => {
          if (
            this.pending.get(element) !== job ||
            !element.isConnected ||
            element.textContent !== text ||
            resolveCodeLanguage(element.dataset.highlightLang) !== language
          )
            return;
          if (html !== null) element.innerHTML = html;
        },
        priority
      );
    }
  }

  dispose(): void {
    for (const job of this.pending.values()) job.cancel();
    this.pending.clear();
  }
}
