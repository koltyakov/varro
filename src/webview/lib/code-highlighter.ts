import { createSignal } from 'solid-js';

type CodeHighlighter = {
  hasLanguage: (language: string) => boolean;
  highlightCode: (text: string, language: string) => string;
};
type CodeHighlighterLoader = () => Promise<CodeHighlighter>;

const MAX_HIGHLIGHT_CHARACTERS = 20_000;
const MAX_HIGHLIGHT_LINE_CHARACTERS = 1_000;

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

export { codeHighlighterVersion };

export function resolveCodeLanguage(language?: string): string | undefined {
  const trimmed = language?.trim();
  if (!trimmed) return undefined;

  const normalized = CODE_LANGUAGE_ALIASES.get(trimmed.toLowerCase()) ?? trimmed.toLowerCase();
  return !codeHighlighter || codeHighlighter.hasLanguage(normalized) ? normalized : undefined;
}

export function highlightCode(text: string, language: string): string | null {
  // Highlight.js runs synchronously. Some language matchers take quadratic time on
  // long lines, so a timeout around the call cannot keep the webview responsive.
  if (text.length > MAX_HIGHLIGHT_CHARACTERS) return null;
  let lineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n' || char === '\r') lineLength = 0;
    else if (++lineLength > MAX_HIGHLIGHT_LINE_CHARACTERS) return null;
  }
  return codeHighlighter?.highlightCode(text, language) ?? null;
}

export function loadCodeHighlighter(
  loader: CodeHighlighterLoader = () => import('./syntax-highlighter')
): Promise<void> {
  if (codeHighlighter) return Promise.resolve();
  if (codeHighlighterLoad) return codeHighlighterLoad;

  codeHighlighterLoad = loader()
    .then((module) => {
      codeHighlighter = module;
      setCodeHighlighterVersion((version) => version + 1);
    })
    .catch((error) => {
      codeHighlighterLoad = null;
      throw error;
    });
  return codeHighlighterLoad;
}
