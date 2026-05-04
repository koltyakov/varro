import { createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import phpTemplate from 'highlight.js/lib/languages/php-template';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import pythonRepl from 'highlight.js/lib/languages/python-repl';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import wasm from 'highlight.js/lib/languages/wasm';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { marked } from 'marked';
import { postMessage } from '../lib/bridge';
import { state } from '../lib/state';
import { formatDisplayPath, normalizePath } from '../lib/path-display';
import { formatCommandDisplay } from '../lib/command-display';

interface MarkdownProps {
  content: string;
  cacheByContent?: boolean;
}

type ParseMarkdownOptions = {
  cacheByContent: boolean;
  disablePathLinkify?: boolean;
  disableCodeHighlighting?: boolean;
};

type StreamingMarkdownSegments = {
  stableContent: string;
  tailContent: string;
};

type MarkdownFenceState = {
  char: string;
  length: number;
};

type StreamingMarkdownScanState = {
  content: string;
  lastBoundary: number | null;
  openFence: MarkdownFenceState | null;
  resumeIndex: number;
  resumeLastBoundary: number | null;
  resumeOpenFence: MarkdownFenceState | null;
};

type MarkdownRenderSegments = StreamingMarkdownSegments & {
  scanState: StreamingMarkdownScanState | null;
  hasUnclosedFence: boolean;
};

type MarkdownHydrationFlags = {
  tables: boolean;
  copyButtons: boolean;
};

type RenderMarkdownContext = {
  disableCodeHighlighting: boolean;
};

type IdleSchedulerGlobal = typeof globalThis & {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (id: number) => void;
};

type IdleWorkHandle =
  | { kind: 'idle'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

const copySvg =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h1V2.5a.5.5 0 01.5-.5h8a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H12v1h1.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 1h-8A1.5 1.5 0 004 2.5V4zm-2 1.5A1.5 1.5 0 013.5 4h8A1.5 1.5 0 0113 5.5v8a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 012 13.5v-8zM3.5 5a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5v-8a.5.5 0 00-.5-.5h-8z"/></svg>';
const checkSvg =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';

const renderer = new marked.Renderer();
let renderMarkdownContext: RenderMarkdownContext | null = null;
const SHELL_LANGS = new Set(['', 'bash', 'console', 'shell', 'sh', 'zsh']);
const REGISTERED_HIGHLIGHT_LANGUAGES = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['diff', diff],
  ['go', go],
  ['graphql', graphql],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['kotlin', kotlin],
  ['less', less],
  ['lua', lua],
  ['makefile', makefile],
  ['markdown', markdown],
  ['objectivec', objectivec],
  ['perl', perl],
  ['php', php],
  ['php-template', phpTemplate],
  ['plaintext', plaintext],
  ['python', python],
  ['python-repl', pythonRepl],
  ['r', r],
  ['ruby', ruby],
  ['rust', rust],
  ['scss', scss],
  ['shell', shell],
  ['sql', sql],
  ['swift', swift],
  ['typescript', typescript],
  ['vbnet', vbnet],
  ['wasm', wasm],
  ['xml', xml],
  ['yaml', yaml],
] as const;
const COMPACT_FIRST_COLUMN_HEADERS = new Set(['#', 'no', 'no.', 'num', 'id']);
const ALLOWED_HTML_TAGS = [
  'a',
  'blockquote',
  'br',
  'button',
  'code',
  'del',
  'div',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'line',
  'ol',
  'p',
  'path',
  'polyline',
  'pre',
  'span',
  'strong',
  'svg',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];
const ALLOWED_HTML_ATTRIBUTES = [
  'aria-hidden',
  'aria-label',
  'class',
  'data-copy',
  'data-copy-text',
  'data-external',
  'data-file',
  'data-lang',
  'd',
  'fill',
  'height',
  'href',
  'points',
  'role',
  'stroke',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-width',
  'title',
  'type',
  'viewBox',
  'width',
  'x1',
  'x2',
  'y1',
  'y2',
];
const CODE_BLOCK_CACHE_LIMIT = 100;
const RENDERED_MARKDOWN_CACHE_LIMIT = 100;
const MAX_COPY_TEXT_LENGTH = 20_000;
const codeBlockHtmlCache = new Map<string, string>();
const highlightedCodeCache = new Map<string, string>();
const renderedMarkdownCache = new Map<string, string>();
const CODE_LANGUAGE_ALIASES = new Map<string, string>([
  ['console', 'bash'],
  ['html', 'xml'],
  ['htm', 'xml'],
  ['md', 'markdown'],
  ['plain', 'plaintext'],
  ['py', 'python'],
  ['shell', 'bash'],
  ['sh', 'bash'],
  ['text', 'plaintext'],
  ['txt', 'plaintext'],
  ['yml', 'yaml'],
  ['zsh', 'bash'],
]);

for (const [name, language] of REGISTERED_HIGHLIGHT_LANGUAGES) {
  hljs.registerLanguage(name, language);
}

interface CodeBlockHtmlParams {
  text: string;
  lang?: string;
  className?: string;
  copyText?: string;
  showCopyButton?: boolean;
  disableHighlighting?: boolean;
  disableCache?: boolean;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setCachedValue(cache: Map<string, string>, key: string, value: string) {
  cache.set(key, value);
  if (cache.size > CODE_BLOCK_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

function setRenderedMarkdownCacheValue(key: string, value: string) {
  renderedMarkdownCache.set(key, value);
  if (renderedMarkdownCache.size > RENDERED_MARKDOWN_CACHE_LIMIT) {
    const oldest = renderedMarkdownCache.keys().next().value;
    if (oldest) renderedMarkdownCache.delete(oldest);
  }
}

function hashContent(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function getRenderedMarkdownCacheKey(content: string) {
  return `${hashContent(state.editorContext.workspacePath || '')}\u0000${hashContent(content)}`;
}

function resolveCodeLanguage(lang?: string) {
  const trimmed = lang?.trim();
  if (!trimmed) return undefined;

  const normalized = CODE_LANGUAGE_ALIASES.get(trimmed.toLowerCase()) ?? trimmed.toLowerCase();
  return hljs.getLanguage(normalized) ? normalized : undefined;
}

export function renderHighlightedCodeHtml(text: string, lang?: string): string {
  const cacheKey = `${lang || ''}\u0000${text}`;
  const cached = highlightedCodeCache.get(cacheKey);
  if (cached) {
    highlightedCodeCache.delete(cacheKey);
    highlightedCodeCache.set(cacheKey, cached);
    return cached;
  }

  const resolvedLanguage = resolveCodeLanguage(lang);
  const highlighted = (() => {
    if (!resolvedLanguage) return escapeHtml(text);
    try {
      return hljs.highlight(text, { language: resolvedLanguage, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(text);
    }
  })();

  setCachedValue(highlightedCodeCache, cacheKey, highlighted);
  return highlighted;
}

export function renderCodeBlockHtml(params: CodeBlockHtmlParams): string {
  const lang = params.lang?.trim() || undefined;
  const className = params.className?.trim();
  const copyText = params.copyText ?? params.text;
  const showCopyButton = params.showCopyButton !== false;
  const disableHighlighting = params.disableHighlighting === true;
  const disableCache = params.disableCache === true;
  const cacheKey = [
    className || '',
    lang || '',
    showCopyButton ? 'copy' : 'nocopy',
    params.text,
    copyText,
  ].join('\u0000');
  if (!disableCache) {
    const cached = codeBlockHtmlCache.get(cacheKey);
    if (cached) {
      codeBlockHtmlCache.delete(cacheKey);
      codeBlockHtmlCache.set(cacheKey, cached);
      return cached;
    }
  }

  const highlighted = disableHighlighting
    ? escapeHtml(params.text)
    : renderHighlightedCodeHtml(params.text, lang);
  const langLabel = lang ? `<span class="code-block-lang">${escapeHtml(lang)}</span>` : '';
  const copyBtn = showCopyButton
    ? `<button type="button" class="code-block-copy-btn" data-copy data-copy-text="${encodeCopyPayload(copyText)}" aria-label="Copy code" title="Copy code">${copySvg}</button>`
    : '';
  const header =
    langLabel || copyBtn ? `<div class="code-block-header">${langLabel}${copyBtn}</div>` : '';
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
  const classAttr = ['interactive-result-code-block', className].filter(Boolean).join(' ');
  const html = `<div class="${classAttr}"${langAttr}>${header}<pre class="code-block"><code class="hljs">${highlighted}</code></pre></div>`;

  if (!disableCache) {
    setCachedValue(codeBlockHtmlCache, cacheKey, html);
  }
  return html;
}

function encodeCopyPayload(value: string) {
  return encodeURIComponent(value);
}

function decodeCopyPayload(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeCopyText(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[^\t\n -\uFFFF]/g, '')
    .slice(0, MAX_COPY_TEXT_LENGTH);
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, '');
}

function isAbsolutePath(path: string) {
  const normalizedPath = normalizePath(path);
  return normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
}

function splitPathReference(
  raw: string
): { path: string; line?: number; lineSuffix?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(.*):(\d+(?:-\d+)?)$/);
  if (!match) return { path: trimmed };

  return {
    path: match[1],
    line: parseInt(match[2], 10),
    lineSuffix: match[2],
  };
}

function toAbsolutePath(path: string) {
  if (isAbsolutePath(path)) return normalizePath(path);

  const workspacePath = state.editorContext.workspacePath;
  if (!workspacePath) return normalizePath(path);

  const relativePath = normalizePath(path).replace(/^\.\//, '');
  return `${trimTrailingSlashes(normalizePath(workspacePath))}/${relativePath}`;
}

function buildFileLink(raw: string, label?: string) {
  const parsed = splitPathReference(raw);
  if (!parsed) return null;

  const absolutePath = toAbsolutePath(parsed.path);
  const displayBase = formatDisplayPath(absolutePath, state.editorContext.workspacePath);
  const displayPath = parsed.lineSuffix ? `${displayBase}:${parsed.lineSuffix}` : displayBase;
  const visibleLabel =
    !label || label.trim() === '' || normalizePath(label.trim()) === normalizePath(raw.trim())
      ? displayPath
      : label.trim();
  const payload = JSON.stringify(
    parsed.line != null ? { path: absolutePath, line: parsed.line } : { path: absolutePath }
  );
  const href = parsed.line != null ? `${absolutePath}:${parsed.line}` : absolutePath;

  return {
    href: escapeHtml(href),
    payload: escapeHtml(payload),
    label: escapeHtml(visibleLabel),
  };
}

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const workspacePath = state.editorContext.workspacePath || '';
  const normalizedText = SHELL_LANGS.has((lang || '').toLowerCase())
    ? formatCommandDisplay(text, workspacePath || null)
    : text;
  return renderCodeBlockHtml({
    text: normalizedText,
    lang,
    copyText: normalizedText,
    disableHighlighting: renderMarkdownContext?.disableCodeHighlighting,
    disableCache: renderMarkdownContext?.disableCodeHighlighting,
  });
};

renderer.link = function ({
  href,
  text,
  title,
}: {
  href: string;
  text: string;
  title?: string | null;
}) {
  if (isLocalFileHref(href)) {
    const link = buildFileLink(href, text);
    if (link) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${link.href}" class="file-path-link" data-file="${link.payload}"${titleAttr}>${link.label}</a>`;
    }
  }

  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}"${titleAttr}>${text}</a>`;
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: false,
});

const FILE_PATH_RE =
  /(?:^|[\s(])(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.[\w]+(?::\d+(?:-\d+)?)?)(?=[\s),.]|$)/g;
const FILE_PATH_CANDIDATE_RE = /\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/;
const PRESERVED_HTML_PLACEHOLDER_RE = /@@VARRO_PRESERVE_(\d+)@@/g;
const MARKDOWN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_FENCE_INFO_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ANCHOR_RE = /(<a[\s\S]*?<\/a>)/gi;
const SVG_RE = /(<svg[\s\S]*?<\/svg>)/gi;
const BUTTON_RE = /(<button[\s\S]*?<\/button>)/gi;
const INLINE_CODE_RE = /(<code[\s\S]*?<\/code>)/gi;
const PRE_RE = /(<pre[\s\S]*?<\/pre>)/gi;

function requestIdleWork(callback: () => void): IdleWorkHandle {
  const idleScheduler = globalThis as IdleSchedulerGlobal;
  if (idleScheduler.requestIdleCallback) {
    return { kind: 'idle', id: idleScheduler.requestIdleCallback(callback) };
  }
  return { kind: 'timeout', id: setTimeout(callback, 0) };
}

function cancelIdleWork(handle: IdleWorkHandle | null) {
  if (!handle) return;

  if (handle.kind === 'idle') {
    const idleScheduler = globalThis as IdleSchedulerGlobal;
    idleScheduler.cancelIdleCallback?.(handle.id);
    return;
  }

  clearTimeout(handle.id);
}

function isLocalFileHref(href: string | null): boolean {
  if (!href) return false;
  if (href.startsWith('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  if (href.startsWith('//')) return false;
  return (
    href.startsWith('/') ||
    href.startsWith('./') ||
    href.startsWith('../') ||
    /^[A-Za-z]:[/\\]/.test(href)
  );
}

function isSafeExternalHref(href: string | null): boolean {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeAnchorHref(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')?.trim() || '';
  if (isLocalFileHref(href)) {
    anchor.setAttribute('href', href);
    anchor.removeAttribute('data-external');
    return;
  }

  if (isSafeExternalHref(href)) {
    anchor.setAttribute('href', href);
    anchor.setAttribute('data-external', 'true');
    return;
  }

  anchor.removeAttribute('href');
  anchor.removeAttribute('data-external');
}

function sanitizeHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ALLOWED_HTML_TAGS,
    ALLOWED_ATTR: ALLOWED_HTML_ATTRIBUTES,
    FORBID_ATTR: ['style'],
  });

  if (!sanitized.includes('<a')) return sanitized;

  const template = document.createElement('template');
  template.innerHTML = sanitized;
  for (const anchor of Array.from(template.content.querySelectorAll<HTMLAnchorElement>('a'))) {
    sanitizeAnchorHref(anchor);
  }
  return template.innerHTML;
}

function renderMarkdownHtml(
  content: string,
  options?: { disablePathLinkify?: boolean; disableCodeHighlighting?: boolean }
): string {
  const previousRenderMarkdownContext = renderMarkdownContext;
  renderMarkdownContext = {
    disableCodeHighlighting: options?.disableCodeHighlighting === true,
  };
  try {
    const parsed = marked.parse(content) as string;
    return sanitizeHtml(options?.disablePathLinkify ? parsed : linkifyPaths(parsed));
  } catch {
    return `<p>${escapeHtml(content)}</p>`;
  } finally {
    renderMarkdownContext = previousRenderMarkdownContext;
  }
}

function cloneFenceState(fence: MarkdownFenceState | null): MarkdownFenceState | null {
  return fence ? { ...fence } : null;
}

function scanLastSafeMarkdownBoundary(
  content: string,
  previousState?: StreamingMarkdownScanState | null
): StreamingMarkdownScanState {
  if (previousState?.content === content) {
    return previousState;
  }

  let index = 0;
  let lastBoundary: number | null = null;
  let openFence = null as MarkdownFenceState | null;
  if (previousState && content.startsWith(previousState.content)) {
    index = previousState.resumeIndex;
    lastBoundary = previousState.resumeLastBoundary;
    openFence = cloneFenceState(previousState.resumeOpenFence);
  }

  let resumeIndex = 0;
  let resumeLastBoundary: number | null = null;
  let resumeOpenFence = null as MarkdownFenceState | null;

  while (index < content.length) {
    resumeIndex = index;
    resumeLastBoundary = lastBoundary;
    resumeOpenFence = cloneFenceState(openFence);

    const nextBreak = content.indexOf('\n', index);
    const lineEnd = nextBreak === -1 ? content.length : nextBreak;
    const rawLine = content.slice(index, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const fenceMatch = line.match(MARKDOWN_FENCE_RE);
    const wasInsideFence = openFence !== null;

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!openFence) {
        openFence = { char: marker[0], length: marker.length };
      } else if (marker[0] === openFence.char && marker.length >= openFence.length) {
        openFence = null;
      }
    }

    const nextIndex = nextBreak === -1 ? content.length : nextBreak + 1;
    const closedFence = wasInsideFence && openFence === null;
    if (closedFence && nextIndex < content.length) {
      lastBoundary = nextIndex;
    }
    if (!openFence && line.trim().length === 0 && nextIndex < content.length) {
      lastBoundary = nextIndex;
    }

    index = nextIndex;
  }

  return {
    content,
    lastBoundary,
    openFence: cloneFenceState(openFence),
    resumeIndex,
    resumeLastBoundary,
    resumeOpenFence,
  };
}

function getStreamingMarkdownSegments(
  content: string,
  previousState?: StreamingMarkdownScanState | null
): MarkdownRenderSegments {
  const scanState = scanLastSafeMarkdownBoundary(content, previousState);
  const hasUnclosedFence = scanState.openFence !== null;
  if (scanState.lastBoundary === null) {
    return {
      stableContent: '',
      tailContent: content,
      scanState,
      hasUnclosedFence,
    };
  }

  const stableContent = content.slice(0, scanState.lastBoundary).trimEnd();
  const tailContent = content.slice(scanState.lastBoundary);
  if (!stableContent || !tailContent.trim()) {
    return {
      stableContent: '',
      tailContent: content,
      scanState,
      hasUnclosedFence,
    };
  }

  return {
    stableContent,
    tailContent,
    scanState,
    hasUnclosedFence,
  };
}

export function splitStreamingMarkdownContent(content: string): StreamingMarkdownSegments {
  const { stableContent, tailContent } = getStreamingMarkdownSegments(content);
  return { stableContent, tailContent };
}

function hasCompletedHighlightableFence(content: string) {
  let index = 0;
  let openFence = null as (MarkdownFenceState & { highlightable: boolean }) | null;

  while (index < content.length) {
    const nextBreak = content.indexOf('\n', index);
    const lineEnd = nextBreak === -1 ? content.length : nextBreak;
    const rawLine = content.slice(index, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const fenceMatch = line.match(MARKDOWN_FENCE_INFO_RE);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!openFence) {
        const lang = fenceMatch[2].trim().split(/\s+/, 1)[0];
        openFence = {
          char: marker[0],
          length: marker.length,
          highlightable: !!resolveCodeLanguage(lang),
        };
      } else if (marker[0] === openFence.char && marker.length >= openFence.length) {
        if (openFence.highlightable) {
          return true;
        }
        openFence = null;
      }
    }

    index = nextBreak === -1 ? content.length : nextBreak + 1;
  }

  return false;
}

function getMarkdownRenderSegments(
  content: string,
  cacheByContent: boolean,
  previousScanState?: StreamingMarkdownScanState | null
): MarkdownRenderSegments {
  if (cacheByContent) {
    return {
      stableContent: '',
      tailContent: content,
      scanState: null,
      hasUnclosedFence: false,
    };
  }

  return getStreamingMarkdownSegments(content, previousScanState);
}

function parseMarkdown(content: string, options: ParseMarkdownOptions): string {
  if (!options.cacheByContent) {
    return renderMarkdownHtml(content, {
      disablePathLinkify: options.disablePathLinkify,
      disableCodeHighlighting: options.disableCodeHighlighting,
    });
  }

  const cacheKey = getRenderedMarkdownCacheKey(content);
  const cached = renderedMarkdownCache.get(cacheKey);
  if (cached) {
    renderedMarkdownCache.delete(cacheKey);
    renderedMarkdownCache.set(cacheKey, cached);
    return cached;
  }

  const html = renderMarkdownHtml(content, {
    disablePathLinkify: options.disablePathLinkify,
    disableCodeHighlighting: options.disableCodeHighlighting,
  });
  setRenderedMarkdownCacheValue(cacheKey, html);
  return html;
}

export function __parseMarkdownForTests(
  content: string,
  options: {
    cacheByContent: boolean;
    disablePathLinkify?: boolean;
    disableCodeHighlighting?: boolean;
  }
): string {
  return parseMarkdown(content, options);
}

export function __resetMarkdownCachesForTests() {
  codeBlockHtmlCache.clear();
  highlightedCodeCache.clear();
  renderedMarkdownCache.clear();
}

function linkifyPaths(html: string): string {
  if (!FILE_PATH_CANDIDATE_RE.test(html)) return html;

  const preserved: string[] = [];
  let idx = 0;
  const placeholder = () => `@@VARRO_PRESERVE_${idx++}@@`;
  const protect = (re: RegExp) => {
    html = html.replace(re, (m) => {
      preserved.push(m);
      return placeholder();
    });
  };

  protect(SVG_RE);
  protect(BUTTON_RE);
  protect(ANCHOR_RE);
  protect(PRE_RE);
  protect(INLINE_CODE_RE);

  html = html.replace(FILE_PATH_RE, (full, path: string) => {
    const link = buildFileLink(path);
    if (!link) return full;
    return full.replace(
      path,
      `<a href="${link.href}" class="file-path-link" data-file="${link.payload}">${link.label}</a>`
    );
  });

  return html.replace(
    PRESERVED_HTML_PLACEHOLDER_RE,
    (_match, index: string) => preserved[Number(index)] || ''
  );
}

function normalizeCellText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isCompactFirstColumnValue(value: string): boolean {
  const normalized = normalizeCellText(value);
  if (!normalized) return true;
  if (normalized.length > 6) return false;
  if (/[\\/]/.test(normalized)) return false;
  if (/[():[\]{}]/.test(normalized)) return false;
  if (/\.[a-z0-9]{1,4}$/i.test(normalized)) return false;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return true;
  if (/^[a-z]{0,3}\d{1,3}[a-z0-9-]*$/i.test(normalized)) return true;
  return false;
}

function shouldUseCompactFirstColumn(table: HTMLTableElement): boolean {
  const headerCell = table.querySelector('thead th:first-child, tr:first-child > th:first-child');
  const headerText = normalizeCellText(headerCell?.textContent || '');
  if (COMPACT_FIRST_COLUMN_HEADERS.has(headerText)) return true;

  const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
  const fallbackRows =
    bodyRows.length > 0 ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1);
  const firstColumnValues = fallbackRows
    .map((row) => row.querySelector('td:first-child, th:first-child')?.textContent || '')
    .map(normalizeCellText)
    .filter((value) => value.length > 0)
    .slice(0, 8);

  if (firstColumnValues.length === 0) return false;
  return firstColumnValues.every(isCompactFirstColumnValue);
}

function applyTableColumnClasses(root: HTMLDivElement | undefined) {
  if (!root) return;
  const tables = root.querySelectorAll<HTMLTableElement>('table');
  for (const table of tables) {
    table.classList.toggle('table-first-col-compact', shouldUseCompactFirstColumn(table));
  }
}

function applyCodeBlockCopyIcons(root: HTMLDivElement | undefined) {
  if (!root) return;
  const buttons = root.querySelectorAll<HTMLButtonElement>('button[data-copy]');
  for (const button of buttons) {
    if (!button.querySelector('svg')) {
      button.innerHTML = copySvg;
    }
    if (button.dataset.copyText) {
      button.dataset.copyText = encodeCopyPayload(
        sanitizeCopyText(decodeCopyPayload(button.dataset.copyText))
      );
    }
  }
}

function getMarkdownHydrationFlags(html: string): MarkdownHydrationFlags {
  return {
    tables: html.includes('<table'),
    copyButtons: html.includes('data-copy'),
  };
}

function hydrateRenderedMarkdown(root: HTMLDivElement | undefined, flags: MarkdownHydrationFlags) {
  if (flags.tables) applyTableColumnClasses(root);
  if (flags.copyButtons) applyCodeBlockCopyIcons(root);
}

export function MarkdownRenderer(props: MarkdownProps) {
  // oxlint-disable-next-line no-unassigned-vars
  let ref: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let stableRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let tailRef: HTMLDivElement | undefined;

  let pendingContent: string | null = null;
  let rafId: number | null = null;
  let idleHighlightId: IdleWorkHandle | null = null;
  let hasProcessedStreamingUpdate = false;
  const initialSegments = getMarkdownRenderSegments(props.content || '', !!props.cacheByContent);
  let lastAppliedScanState = initialSegments.scanState;
  let lastAppliedWorkspacePath = state.editorContext.workspacePath || '';
  let lastAppliedStableContent = initialSegments.stableContent;
  let lastAppliedTailContent = initialSegments.tailContent;
  let lastAppliedStableHtml = initialSegments.stableContent
    ? parseMarkdown(initialSegments.stableContent, { cacheByContent: true })
    : '';
  let lastAppliedTailHtml = parseMarkdown(initialSegments.tailContent, {
    cacheByContent: initialSegments.stableContent.length === 0 && !!props.cacheByContent,
    disablePathLinkify: !props.cacheByContent,
    disableCodeHighlighting: initialSegments.hasUnclosedFence,
  });
  let lastAppliedStableHydrationFlags = getMarkdownHydrationFlags(lastAppliedStableHtml);
  let lastAppliedTailHydrationFlags = getMarkdownHydrationFlags(lastAppliedTailHtml);

  const [stableHtml, setStableHtml] = createSignal(lastAppliedStableHtml);
  const [tailHtml, setTailHtml] = createSignal(lastAppliedTailHtml);

  function scheduleDeferredTailHighlight(content: string, workspacePath: string) {
    cancelIdleWork(idleHighlightId);
    idleHighlightId = requestIdleWork(() => {
      idleHighlightId = null;
      if (pendingContent !== null) return;
      if (workspacePath !== lastAppliedWorkspacePath) return;
      if (content !== lastAppliedTailContent) return;

      const highlightedTailHtml = parseMarkdown(content, {
        cacheByContent: false,
        disablePathLinkify: !props.cacheByContent,
      });
      if (highlightedTailHtml === lastAppliedTailHtml) return;

      lastAppliedTailHtml = highlightedTailHtml;
      lastAppliedTailHydrationFlags = getMarkdownHydrationFlags(highlightedTailHtml);
      setTailHtml(highlightedTailHtml);
      queueMicrotask(() => {
        hydrateRenderedMarkdown(tailRef, lastAppliedTailHydrationFlags);
      });
    });
  }

  function flushPending() {
    rafId = null;
    if (pendingContent !== null) {
      const content = pendingContent;
      pendingContent = null;
      cancelIdleWork(idleHighlightId);
      idleHighlightId = null;
      const segments = getMarkdownRenderSegments(
        content,
        !!props.cacheByContent,
        lastAppliedScanState
      );
      const workspacePath = state.editorContext.workspacePath || '';
      const stableContentChanged =
        workspacePath !== lastAppliedWorkspacePath ||
        segments.stableContent !== lastAppliedStableContent;
      const tailContentChanged =
        workspacePath !== lastAppliedWorkspacePath ||
        segments.tailContent !== lastAppliedTailContent;
      const nextStableHtml =
        segments.stableContent.length === 0
          ? ''
          : stableContentChanged
            ? parseMarkdown(segments.stableContent, { cacheByContent: true })
            : lastAppliedStableHtml;
      const shouldDeferTailHighlight =
        hasProcessedStreamingUpdate &&
        tailContentChanged &&
        !props.cacheByContent &&
        !segments.hasUnclosedFence &&
        hasCompletedHighlightableFence(segments.tailContent);
      const nextTailHtml = tailContentChanged
        ? parseMarkdown(segments.tailContent, {
            cacheByContent: segments.stableContent.length === 0 && !!props.cacheByContent,
            disablePathLinkify: !props.cacheByContent,
            disableCodeHighlighting: segments.hasUnclosedFence || shouldDeferTailHighlight,
          })
        : lastAppliedTailHtml;

      const stableChanged = nextStableHtml !== lastAppliedStableHtml;
      const tailChanged = nextTailHtml !== lastAppliedTailHtml;
      if (stableChanged) {
        lastAppliedStableContent = segments.stableContent;
        lastAppliedStableHtml = nextStableHtml;
        lastAppliedStableHydrationFlags = getMarkdownHydrationFlags(nextStableHtml);
        setStableHtml(nextStableHtml);
      } else if (stableContentChanged) {
        lastAppliedStableContent = segments.stableContent;
      }
      if (tailChanged) {
        lastAppliedTailContent = segments.tailContent;
        lastAppliedTailHtml = nextTailHtml;
        lastAppliedTailHydrationFlags = getMarkdownHydrationFlags(nextTailHtml);
        setTailHtml(nextTailHtml);
      } else if (tailContentChanged) {
        lastAppliedTailContent = segments.tailContent;
      }
      lastAppliedWorkspacePath = workspacePath;
      lastAppliedScanState = segments.scanState;
      hasProcessedStreamingUpdate = true;

      if (shouldDeferTailHighlight) {
        scheduleDeferredTailHighlight(segments.tailContent, workspacePath);
      }

      queueMicrotask(() => {
        if (stableChanged) {
          hydrateRenderedMarkdown(stableRef, lastAppliedStableHydrationFlags);
        }
        if (tailChanged) {
          hydrateRenderedMarkdown(tailRef, lastAppliedTailHydrationFlags);
        }
      });
    }
  }

  createEffect(() => {
    const content = props.content || '';
    const workspacePath = state.editorContext.workspacePath;
    if (rafId !== null) {
      pendingContent = content;
      return;
    }
    pendingContent = content;
    rafId = requestAnimationFrame(flushPending);
    void workspacePath;
  });

  const copyTimeouts = new Set<ReturnType<typeof setTimeout>>();

  onCleanup(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    cancelIdleWork(idleHighlightId);
    idleHighlightId = null;
    for (const id of copyTimeouts) clearTimeout(id);
    copyTimeouts.clear();
  });

  function handleClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]');
    if (btn) {
      const block = btn.closest('.interactive-result-code-block');
      const code = block?.querySelector('code');
      if (!code) return;
      const copyText = sanitizeCopyText(
        btn.dataset.copyText ? decodeCopyPayload(btn.dataset.copyText) : (code.textContent ?? '')
      );
      if (!copyText) return;
      navigator.clipboard.writeText(copyText).catch(() => {});
      btn.innerHTML = checkSvg;
      const tid = setTimeout(() => {
        copyTimeouts.delete(tid);
        btn.innerHTML = copySvg;
      }, 1500);
      copyTimeouts.add(tid);
      return;
    }

    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.file-path-link');
    if (link) {
      e.preventDefault();
      try {
        const payload = JSON.parse(link.dataset.file || '{}');
        postMessage({
          type: 'vscode/open',
          payload: { path: payload.path, line: payload.line, kind: 'file' },
        });
      } catch {}
      return;
    }

    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (anchor?.dataset.external === 'true') {
      const href = anchor.getAttribute('href');
      if (isSafeExternalHref(href)) {
        e.preventDefault();
        postMessage({ type: 'vscode/open-external', payload: { url: href! } });
      }
      return;
    }

    if (anchor && isLocalFileHref(anchor.getAttribute('href'))) {
      e.preventDefault();
      const payload = splitPathReference(anchor.getAttribute('href') || '');
      if (payload?.path) {
        postMessage({
          type: 'vscode/open',
          payload: { path: payload.path, line: payload.line, kind: 'file' },
        });
      }
    }
  }

  onMount(() => {
    ref?.addEventListener('click', handleClick);
    queueMicrotask(() => {
      hydrateRenderedMarkdown(stableRef, lastAppliedStableHydrationFlags);
      hydrateRenderedMarkdown(tailRef, lastAppliedTailHydrationFlags);
    });
  });
  onCleanup(() => {
    ref?.removeEventListener('click', handleClick);
  });

  return (
    <div ref={ref} class="rendered-markdown">
      <div
        ref={stableRef}
        data-markdown-segment="stable"
        style={{ display: stableHtml() ? 'contents' : 'none' }}
        innerHTML={stableHtml()}
      />
      <div
        ref={tailRef}
        data-markdown-segment="tail"
        style={{ display: tailHtml() ? 'contents' : 'none' }}
        innerHTML={tailHtml()}
      />
    </div>
  );
}
