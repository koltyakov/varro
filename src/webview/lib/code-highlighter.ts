import { createSignal } from 'solid-js';

type CodeHighlighter = {
  hasLanguage: (language: string) => boolean;
  highlightCode: (text: string, language: string) => string;
};

const CODE_LANGUAGE_ALIASES = new Map<string, string>([
  ['console', 'bash'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['html', 'xml'],
  ['htm', 'xml'],
  ['md', 'markdown'],
  ['plain', 'plaintext'],
  ['py', 'python'],
  ['shell', 'bash'],
  ['sh', 'bash'],
  ['text', 'plaintext'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['txt', 'plaintext'],
  ['yml', 'yaml'],
  ['zsh', 'bash'],
]);
const [codeHighlighterVersion, setCodeHighlighterVersion] = createSignal(0);
let codeHighlighter: CodeHighlighter | null = null;
let codeHighlighterLoad: Promise<void> | null = null;
let codeHighlighterLoadFailed = false;

export { codeHighlighterVersion };

export function resolveCodeLanguage(language?: string): string | undefined {
  const trimmed = language?.trim();
  if (!trimmed) return undefined;

  const normalized = CODE_LANGUAGE_ALIASES.get(trimmed.toLowerCase()) ?? trimmed.toLowerCase();
  return !codeHighlighter || codeHighlighter.hasLanguage(normalized) ? normalized : undefined;
}

export function highlightCode(text: string, language: string): string | null {
  return codeHighlighter?.highlightCode(text, language) ?? null;
}

export function loadCodeHighlighter(): Promise<void> {
  if (codeHighlighter || codeHighlighterLoadFailed) return Promise.resolve();
  if (codeHighlighterLoad) return codeHighlighterLoad;

  codeHighlighterLoad = import('./syntax-highlighter')
    .then((module) => {
      codeHighlighter = module;
      setCodeHighlighterVersion((version) => version + 1);
    })
    .catch((error) => {
      codeHighlighterLoadFailed = true;
      throw error;
    });
  return codeHighlighterLoad;
}
