import type { Highlighter, BundledLanguage, BundledTheme } from 'shiki';

const LANGS: BundledLanguage[] = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'jsonc',
  'bash',
  'shellscript',
  'python',
  'go',
  'rust',
  'java',
  'csharp',
  'cpp',
  'c',
  'ruby',
  'php',
  'html',
  'css',
  'scss',
  'xml',
  'yaml',
  'toml',
  'sql',
  'markdown',
  'diff',
  'dockerfile',
];

const THEMES: BundledTheme[] = ['dark-plus', 'light-plus'];

const LANG_ALIASES: Record<string, BundledLanguage> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  docker: 'dockerfile',
};

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: THEMES, langs: LANGS })
    );
  }
  return highlighterPromise;
}

export function resolveLang(lang: string | undefined, hl: Highlighter): BundledLanguage | null {
  if (!lang) return null;
  const key = lang.toLowerCase();
  const aliased = LANG_ALIASES[key] || (key as BundledLanguage);
  const loaded = hl.getLoadedLanguages();
  return loaded.includes(aliased) ? aliased : null;
}

export function getTheme(): BundledTheme {
  return document.body.classList.contains('vscode-light') ? 'light-plus' : 'dark-plus';
}
