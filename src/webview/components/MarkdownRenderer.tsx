import { Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Mermaid, MermaidConfig } from 'mermaid';
import { writeClipboard } from '../lib/write-clipboard';
import { openPathWithResult, postMessage } from '../lib/bridge';
import { logWarn } from '../lib/log';
import {
  codeHighlighterVersion,
  highlightCode,
  loadCodeHighlighter,
  resolveCodeLanguage,
} from '../lib/code-highlighter';
import { state, theme } from '../lib/state';
import { getLeafPathName, normalizePath } from '../lib/path-display';
import { formatCommandDisplay } from '../lib/command-display';
import { getSessionReferenceContextKey, splitSessionReferenceText } from '../lib/session-reference';
import { selectSession } from '../hooks/useOpenCode';
import { trapModalFocus } from '../lib/modal-focus';
import { mixRgb, parseThemeColor } from '../lib/theme';
import { isSafeExternalHref } from '../lib/external-link';
import { createExternalLinkIconElement } from './ExternalLinkIcon';
import { createFileTypeIconElement, hasRecognizedFileType } from './FileTypeIcon';
import { createMaterialChipIconElement } from './MaterialChipIcon';
import { showSessionActionFeedback } from './chat/SessionActionFeedback';

interface MarkdownProps {
  content: string;
  cacheByContent?: boolean;
  lightweight?: boolean;
}

type ParseMarkdownOptions = {
  cacheByContent: boolean;
  disablePathLinkify?: boolean;
  disableCodeHighlighting?: boolean;
  allowMermaidHydration?: boolean;
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
  mermaid: boolean;
};

type RenderMarkdownContext = {
  disablePathLinkify: boolean;
  disableCodeHighlighting: boolean;
  disableCache: boolean;
  allowMermaidHydration: boolean;
};

type MarkdownStringCache = Map<string, MarkdownCacheEntry>;

type MarkdownCacheEntry = {
  cache: MarkdownStringCache;
  key: string;
  value: string;
  bytes: number;
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
const expandSvg =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const closeSvg =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke-linecap="round"/></svg>';

const renderer = new marked.Renderer();
let renderMarkdownContext: RenderMarkdownContext | null = null;
const SHELL_LANGS = new Set(['', 'bash', 'console', 'shell', 'sh', 'zsh']);
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
  'data-mermaid-source',
  'd',
  'fill',
  'height',
  'hidden',
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
const MARKDOWN_CACHE_ENTRY_LIMIT = 100;
const MARKDOWN_CACHE_BYTE_BUDGET = 2 * 1024 * 1024;
const MAX_COPY_TEXT_LENGTH = 20_000;
const MAX_MERMAID_SOURCE_LENGTH = 100_000;
const MERMAID_SVG_CACHE_LIMIT = 20;
const codeBlockHtmlCache: MarkdownStringCache = new Map();
const highlightedCodeCache: MarkdownStringCache = new Map();
const renderedMarkdownCache: MarkdownStringCache = new Map();
const sanitizeHtmlCache: MarkdownStringCache = new Map();
const markdownCacheLru = new Map<MarkdownCacheEntry, true>();
let markdownCacheBytes = 0;
interface CodeBlockHtmlParams {
  text: string;
  lang?: string;
  headerLabel?: string;
  headerDetail?: string;
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

function getUtf8ByteLength(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function deleteMarkdownCacheEntry(entry: MarkdownCacheEntry) {
  if (entry.cache.get(entry.key) === entry) {
    entry.cache.delete(entry.key);
  }
  markdownCacheLru.delete(entry);
  markdownCacheBytes -= entry.bytes;
}

function getCachedValue(cache: MarkdownStringCache, key: string) {
  const entry = cache.get(key);
  if (!entry) return undefined;

  cache.delete(key);
  cache.set(key, entry);
  markdownCacheLru.delete(entry);
  markdownCacheLru.set(entry, true);
  return entry.value;
}

function setCachedValue(cache: MarkdownStringCache, key: string, value: string) {
  const existing = cache.get(key);
  if (existing) deleteMarkdownCacheEntry(existing);

  const bytes = getUtf8ByteLength(key) + getUtf8ByteLength(value);
  if (bytes > MARKDOWN_CACHE_BYTE_BUDGET) return;

  while (cache.size >= MARKDOWN_CACHE_ENTRY_LIMIT) {
    const oldest = cache.values().next().value;
    if (!oldest) break;
    deleteMarkdownCacheEntry(oldest);
  }
  while (markdownCacheBytes + bytes > MARKDOWN_CACHE_BYTE_BUDGET) {
    const oldest = markdownCacheLru.keys().next().value;
    if (!oldest) break;
    deleteMarkdownCacheEntry(oldest);
  }

  const entry = { cache, key, value, bytes } satisfies MarkdownCacheEntry;
  cache.set(key, entry);
  markdownCacheLru.set(entry, true);
  markdownCacheBytes += bytes;
}

function hashContent(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function getRenderedMarkdownCacheKey(content: string, options: ParseMarkdownOptions) {
  return [
    hashContent(state.editorContext.workspacePath || ''),
    hashContent(getSessionReferenceContextKey(content)),
    options.disablePathLinkify ? 'no-paths' : 'paths',
    options.disableCodeHighlighting ? 'plain-code' : `highlight-code:${codeHighlighterVersion()}`,
    options.allowMermaidHydration ? 'hydrate-mermaid' : 'defer-mermaid',
    hashContent(content),
  ].join('\u0000');
}

export function renderHighlightedCodeHtml(
  text: string,
  lang?: string,
  disableCache = false
): string {
  let cacheKey: string | null = null;
  if (!disableCache) {
    cacheKey = `${codeHighlighterVersion()}\u0000${lang || ''}\u0000${text}`;
    const cached = getCachedValue(highlightedCodeCache, cacheKey);
    if (cached !== undefined) return cached;
  }

  const resolvedLanguage = resolveCodeLanguage(lang);
  const highlighted = (() => {
    if (!resolvedLanguage) return escapeHtml(text);
    try {
      const result = highlightCode(text, resolvedLanguage);
      if (result !== null) return result;
      // Highlighting is optional; escaped plaintext remains safe if the chunk cannot load.
      void loadCodeHighlighter().catch(() => {});
      return escapeHtml(text);
    } catch {
      return escapeHtml(text);
    }
  })();

  if (cacheKey !== null) setCachedValue(highlightedCodeCache, cacheKey, highlighted);
  return highlighted;
}

export function renderCodeBlockHtml(params: CodeBlockHtmlParams): string {
  const lang = params.lang?.trim() || undefined;
  const className = params.className?.trim();
  const copyText = params.copyText ?? params.text;
  const showCopyButton = params.showCopyButton !== false;
  const disableHighlighting = params.disableHighlighting === true;
  const disableCache = params.disableCache === true;
  let cacheKey: string | null = null;
  if (!disableCache) {
    cacheKey = [
      disableHighlighting ? 'plain' : codeHighlighterVersion(),
      className || '',
      lang || '',
      params.headerLabel || '',
      params.headerDetail || '',
      showCopyButton ? 'copy' : 'nocopy',
      disableHighlighting ? 'plain' : 'highlight',
      params.text,
      copyText,
    ].join('\u0000');
    const cached = getCachedValue(codeBlockHtmlCache, cacheKey);
    if (cached !== undefined) return cached;
  }

  const highlighted = disableHighlighting
    ? escapeHtml(params.text)
    : renderHighlightedCodeHtml(params.text, lang, disableCache);
  const headerLabel = params.headerLabel ?? lang;
  const langLabel = headerLabel
    ? `<span class="code-block-lang">${escapeHtml(headerLabel)}</span>`
    : '';
  const headerDetail = params.headerDetail
    ? `<span class="code-block-detail">${escapeHtml(params.headerDetail)}</span>`
    : '';
  const copyBtn = showCopyButton
    ? `<button type="button" class="code-block-copy-btn" data-copy data-copy-text="${encodeCopyPayload(copyText)}" aria-label="Copy code" title="Copy code">${copySvg}</button>`
    : '';
  const header =
    langLabel || headerDetail || copyBtn
      ? `<div class="code-block-header">${langLabel}${headerDetail}${copyBtn}</div>`
      : '';
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
  const classAttr = ['interactive-result-code-block', className].filter(Boolean).join(' ');
  const html = `<div class="${classAttr}"${langAttr}>${header}<pre class="code-block"><code class="hljs">${highlighted}</code></pre></div>`;

  if (cacheKey !== null) setCachedValue(codeBlockHtmlCache, cacheKey, html);
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

  const match = trimmed.match(/^(.*?)\s+\(line (\d+(?:-\d+)?)\)$/i);
  if (match) {
    return {
      path: match[1]!,
      line: parseInt(match[2]!, 10),
      lineSuffix: ` (line ${match[2]})`,
    };
  }

  const colonMatch = trimmed.match(/^(.*):(\d+(?:-\d+)?)$/);
  if (!colonMatch) return { path: trimmed };

  return {
    path: colonMatch[1]!,
    line: parseInt(colonMatch[2]!, 10),
    lineSuffix: ` (line ${colonMatch[2]})`,
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
  const canonicalPath = `${getLeafPathName(parsed.path)}${parsed.lineSuffix ?? ''}`;
  const plainLabel = label
    ?.trim()
    .replace(/^<code>([\s\S]*)<\/code>$/i, '$1')
    .replace(/^`+|`+$/g, '')
    .trim();
  const visibleLabel =
    !plainLabel || FILE_PATH_REFERENCE_RE.test(plainLabel) ? canonicalPath : label!.trim();
  const payload = JSON.stringify(
    parsed.line != null ? { path: absolutePath, line: parsed.line } : { path: absolutePath }
  );
  const href = parsed.line != null ? `${absolutePath}:${parsed.line}` : absolutePath;
  const title = `${absolutePath}${parsed.lineSuffix ?? ''}`;

  return {
    href: escapeHtml(href),
    payload: escapeHtml(payload),
    label: escapeHtml(visibleLabel),
    title: escapeHtml(title),
  };
}

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  if (lang?.trim().toLowerCase() === 'mermaid' && text.length <= MAX_MERMAID_SOURCE_LENGTH) {
    if (
      renderMarkdownContext?.disableCodeHighlighting &&
      !renderMarkdownContext.allowMermaidHydration
    ) {
      return '<div class="mermaid-diagram mermaid-diagram-pending"><div class="mermaid-diagram-status"><span>Rendering diagram...</span></div></div>';
    }
    const fallback = renderCodeBlockHtml({
      text,
      lang,
      copyText: text,
      className: 'mermaid-diagram-fallback',
      disableHighlighting: true,
      disableCache: renderMarkdownContext?.disableCache,
    }).replace(
      '<div class="interactive-result-code-block',
      '<div hidden class="interactive-result-code-block'
    );
    return `<div class="mermaid-diagram" data-mermaid-source="${encodeCopyPayload(text)}"><div class="mermaid-diagram-status"><span>Rendering diagram...</span></div>${fallback}</div>`;
  }

  const workspacePath = state.editorContext.workspacePath || '';
  const normalizedText = SHELL_LANGS.has((lang || '').toLowerCase())
    ? formatCommandDisplay(text, workspacePath || null)
    : text;
  return renderCodeBlockHtml({
    text: normalizedText,
    lang,
    copyText: normalizedText,
    disableHighlighting: renderMarkdownContext?.disableCodeHighlighting,
    disableCache: renderMarkdownContext?.disableCache,
  });
};

renderer.codespan = function ({ text }: { text: string }) {
  if (!renderMarkdownContext?.disablePathLinkify && isLikelyFilePathReference(text)) {
    const link = buildFileLink(text);
    if (link) {
      return `<a href="${link.href}" class="file-path-link" data-file="${link.payload}" title="${link.title}">${link.label}</a>`;
    }
  }

  return `<code>${escapeHtml(text)}</code>`;
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
      const titleAttr = ` title="${title ? escapeHtml(title) : link.title}"`;
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
  /(?:^|[\s(])(`?)(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.[\w]+(?::\d+(?:-\d+)?|\s+\(line \d+(?:-\d+)?\))?)(`?)(?=[\s),.]|$)/gi;
const FILE_PATH_REFERENCE_RE =
  /^\.?\/?(?:[\w.-]+\/)*(?:[\w.-]+\.[\w]+|dockerfile|license|makefile|\.(?:gitignore|npmrc|nvmrc))(?::\d+(?:-\d+)?|\s+\(line \d+(?:-\d+)?\))?$/i;
const FILE_PATH_CANDIDATE_RE = /\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/;
const SPECIAL_FILE_NAMES = new Set([
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  'dockerfile',
  'license',
  'makefile',
]);
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
    /^[A-Za-z]:[/\\]/.test(href) ||
    FILE_PATH_REFERENCE_RE.test(href)
  );
}

function isLikelyFilePathReference(raw: string): boolean {
  const parsed = splitPathReference(raw);
  if (!parsed || !FILE_PATH_REFERENCE_RE.test(raw.trim())) return false;

  const path = normalizePath(parsed.path);
  if (path.includes('/') || isAbsolutePath(path)) return true;

  const filename = getLeafPathName(path).toLowerCase();
  return SPECIAL_FILE_NAMES.has(filename) || hasRecognizedFileType(filename);
}

function sanitizeAnchorHref(anchor: HTMLAnchorElement) {
  anchor.classList.remove('external-link');
  for (const icon of Array.from(anchor.querySelectorAll('.external-link-icon, .file-path-icon'))) {
    icon.remove();
  }

  const href = anchor.getAttribute('href')?.trim() || '';
  if (isLocalFileHref(href)) {
    anchor.setAttribute('href', href);
    anchor.removeAttribute('data-external');
    if (anchor.classList.contains('file-path-link')) {
      prependLinkIcon(anchor, createFileTypeIconElement(splitPathReference(href)?.path), true);
    }
    return;
  }

  if (isSafeExternalHref(href)) {
    anchor.setAttribute('href', href);
    anchor.setAttribute('data-external', 'true');
    anchor.classList.add('external-link');
    prependLinkIcon(anchor, createExternalLinkIconElement());
    return;
  }

  anchor.removeAttribute('href');
  anchor.removeAttribute('data-external');
}

function prependLinkIcon(anchor: HTMLAnchorElement, icon: HTMLElement, keepFirstWord = false) {
  anchor.setAttribute('aria-label', anchor.textContent ?? '');
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  let firstText = walker.nextNode();
  while (firstText instanceof Text && firstText.data.length === 0) firstText = walker.nextNode();
  if (!(firstText instanceof Text)) {
    anchor.prepend(icon);
    return;
  }

  const leadingText = keepFirstWord
    ? (firstText.data.match(/^\S+/)?.[0] ?? '')
    : (Array.from(firstText.data)[0] ?? '');
  if (!leadingText) {
    anchor.prepend(icon);
    return;
  }

  firstText.data = firstText.data.slice(leadingText.length);
  const leadingContent = document.createElement('span');
  leadingContent.className = 'link-leading-content';
  const leadingLabel = document.createElement('span');
  leadingLabel.className = 'link-leading-label';
  leadingLabel.textContent = leadingText;
  leadingContent.append(icon, leadingLabel);
  anchor.prepend(leadingContent);
}

function linkifySessionReferences(fragment: DocumentFragment) {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest('a, button, code, pre')) continue;
    textNodes.push(node);
  }

  for (const node of textNodes) {
    const segments = splitSessionReferenceText(node.data);
    if (!segments.some((segment) => segment.type === 'session')) continue;

    const replacement = document.createDocumentFragment();
    for (const segment of segments) {
      if (segment.type === 'text') {
        replacement.append(document.createTextNode(segment.content));
        continue;
      }

      const anchor = document.createElement('a');
      anchor.className = 'session-reference-link';
      anchor.href = segment.reference.href;
      anchor.dataset.sessionId = segment.reference.id;
      anchor.title = `Open session ${segment.reference.id}`;
      const icon = createMaterialChipIconElement('session', 'session-reference-icon');
      const label = document.createElement('span');
      label.textContent = segment.reference.title;
      const firstWord = segment.reference.title.match(/^\S+/)?.[0] ?? '';
      const leadingContent = document.createElement('span');
      leadingContent.className = 'link-leading-content';
      const leadingLabel = document.createElement('span');
      leadingLabel.className = 'link-leading-label';
      leadingLabel.textContent = firstWord;
      leadingContent.append(icon, leadingLabel);
      label.textContent = segment.reference.title.slice(firstWord.length);
      anchor.append(leadingContent, label);
      replacement.append(anchor);
    }
    node.replaceWith(replacement);
  }
}

function sanitizeHtml(html: string, disableCache: boolean, sessionContextKey: string): string {
  const cacheKey = `${sessionContextKey}\u0000${html}`;
  if (!disableCache) {
    const cached = getCachedValue(sanitizeHtmlCache, cacheKey);
    if (cached !== undefined) return cached;
  }

  // Take the sanitized DOM rather than a string: re-parsing DOMPurify's own
  // output to rewrite anchors would hand the result back to the HTML parser a
  // second time, which is where mutation-XSS lives. Mutating the fragment
  // DOMPurify vetted keeps a single parse/serialize round trip.
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ALLOWED_HTML_TAGS,
    ALLOWED_ATTR: ALLOWED_HTML_ATTRIBUTES,
    FORBID_ATTR: ['style'],
    RETURN_DOM_FRAGMENT: true,
  });

  for (const anchor of Array.from(fragment.querySelectorAll<HTMLAnchorElement>('a'))) {
    sanitizeAnchorHref(anchor);
  }
  linkifySessionReferences(fragment);

  const container = document.createElement('div');
  container.append(fragment);
  const result = container.innerHTML;

  if (!disableCache) setCachedValue(sanitizeHtmlCache, cacheKey, result);
  return result;
}

function renderMarkdownHtml(
  content: string,
  options?: {
    disablePathLinkify?: boolean;
    disableCodeHighlighting?: boolean;
    disableCache?: boolean;
    allowMermaidHydration?: boolean;
  }
): string {
  const previousRenderMarkdownContext = renderMarkdownContext;
  renderMarkdownContext = {
    disablePathLinkify: options?.disablePathLinkify === true,
    disableCodeHighlighting: options?.disableCodeHighlighting === true,
    disableCache: options?.disableCache === true,
    allowMermaidHydration: options?.allowMermaidHydration === true,
  };
  try {
    const parsed = marked.parse(content) as string;
    const sessionContextKey = getSessionReferenceContextKey(content);
    return sanitizeHtml(
      options?.disablePathLinkify ? parsed : linkifyPaths(parsed),
      options?.disableCache === true,
      sessionContextKey
    );
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
      const marker = fenceMatch[1]!;
      if (!openFence) {
        openFence = { char: marker[0]!, length: marker.length };
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
      const marker = fenceMatch[1]!;
      if (!openFence) {
        const lang = fenceMatch[2]!.trim().split(/\s+/, 1)[0];
        openFence = {
          char: marker[0]!,
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

function isAppendOnlySafeMarkdown(content: string) {
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    if (/^\s/.test(line)) return false;
    if (/[\\`*_~<>[\]|]/.test(line)) return false;
    if (/^(?:#{1,6}(?:\s|$)|>|[-+]\s|\d+[.)]\s|(?:=+|-+)\s*$)/.test(line)) return false;
  }
  return true;
}

function getAppendOnlyStableDelta(
  previousContent: string,
  nextContent: string,
  previousContentWasSafe: boolean
) {
  if (!previousContent || !previousContentWasSafe || !nextContent.startsWith(previousContent)) {
    return null;
  }

  const suffix = nextContent.slice(previousContent.length);
  if (!/^(?:\r?\n){2,}/.test(suffix)) return null;
  const delta = suffix.replace(/^(?:\r?\n)+/, '');
  return delta && isAppendOnlySafeMarkdown(delta) ? delta : null;
}

function parseMarkdown(content: string, options: ParseMarkdownOptions): string {
  if (!options.cacheByContent) {
    return renderMarkdownHtml(content, {
      disablePathLinkify: options.disablePathLinkify,
      disableCodeHighlighting: options.disableCodeHighlighting,
      disableCache: true,
      allowMermaidHydration: options.allowMermaidHydration,
    });
  }

  const cacheKey = getRenderedMarkdownCacheKey(content, options);
  const cached = getCachedValue(renderedMarkdownCache, cacheKey);
  if (cached !== undefined) return cached;

  const html = renderMarkdownHtml(content, {
    disablePathLinkify: options.disablePathLinkify,
    disableCodeHighlighting: options.disableCodeHighlighting,
    allowMermaidHydration: options.allowMermaidHydration,
  });
  setCachedValue(renderedMarkdownCache, cacheKey, html);
  return html;
}

export function __parseMarkdownForTests(
  content: string,
  options: {
    cacheByContent: boolean;
    disablePathLinkify?: boolean;
    disableCodeHighlighting?: boolean;
    allowMermaidHydration?: boolean;
  }
): string {
  return parseMarkdown(content, options);
}

export function __resetMarkdownCachesForTests() {
  codeBlockHtmlCache.clear();
  highlightedCodeCache.clear();
  renderedMarkdownCache.clear();
  sanitizeHtmlCache.clear();
  markdownCacheLru.clear();
  mermaidSvgCache.clear();
  markdownCacheBytes = 0;
}

export function getMarkdownCacheStatsForTests() {
  return {
    bytes: markdownCacheBytes,
    byteBudget: MARKDOWN_CACHE_BYTE_BUDGET,
    entries: markdownCacheLru.size,
  };
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

  html = html.replace(
    FILE_PATH_RE,
    (full, openingTick: string, path: string, closingTick: string) => {
      if (!isLikelyFilePathReference(path)) return full;
      const link = buildFileLink(path);
      if (!link) return full;
      return full.replace(
        `${openingTick}${path}${closingTick}`,
        `<a href="${link.href}" class="file-path-link" data-file="${link.payload}" title="${link.title}">${link.label}</a>`
      );
    }
  );

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
    mermaid: html.includes('data-mermaid-source'),
  };
}

let mermaidRenderSequence = 0;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
const mermaidSvgCache = new Map<string, string>();

function readMermaidThemeColor(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}

function mermaidRgb(value: string, fallback: [number, number, number]) {
  return parseThemeColor(value) ?? fallback;
}

function mermaidRgbString(color: [number, number, number]) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

export function getMermaidThemeConfigForTests(
  body: HTMLElement = document.body,
  styles: CSSStyleDeclaration = getComputedStyle(body)
): MermaidConfig {
  const dark =
    body.classList.contains('vscode-dark') || body.classList.contains('vscode-high-contrast');
  const background = readMermaidThemeColor(
    styles,
    '--vscode-editor-background',
    dark ? '#1e1e1e' : '#ffffff'
  );
  const foreground = readMermaidThemeColor(
    styles,
    '--vscode-editor-foreground',
    dark ? '#d4d4d4' : '#333333'
  );
  const border = readMermaidThemeColor(
    styles,
    '--vscode-widget-border',
    dark ? '#6b6b6b' : '#8c8c8c'
  );
  const accent = readMermaidThemeColor(
    styles,
    '--vscode-focusBorder',
    dark ? '#3794ff' : '#007acc'
  );
  const backgroundRgb = mermaidRgb(background, dark ? [30, 30, 30] : [255, 255, 255]);
  const foregroundRgb = mermaidRgb(foreground, dark ? [212, 212, 212] : [51, 51, 51]);
  const accentRgb = mermaidRgb(accent, dark ? [55, 148, 255] : [0, 122, 204]);
  const primaryFill = mermaidRgbString(mixRgb(foregroundRgb, backgroundRgb, dark ? 0.13 : 0.06));
  const secondaryFill = mermaidRgbString(mixRgb(foregroundRgb, backgroundRgb, dark ? 0.18 : 0.1));
  const tertiaryFill = mermaidRgbString(mixRgb(foregroundRgb, backgroundRgb, dark ? 0.08 : 0.03));
  const accentFill = mermaidRgbString(mixRgb(accentRgb, backgroundRgb, dark ? 0.18 : 0.1));
  const line = mermaidRgbString(mixRgb(foregroundRgb, backgroundRgb, dark ? 0.78 : 0.68));

  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    darkMode: dark,
    htmlLabels: false,
    themeVariables: {
      background,
      mainBkg: primaryFill,
      primaryColor: primaryFill,
      primaryTextColor: foreground,
      primaryBorderColor: border,
      secondaryColor: secondaryFill,
      secondaryTextColor: foreground,
      secondaryBorderColor: border,
      tertiaryColor: tertiaryFill,
      tertiaryTextColor: foreground,
      tertiaryBorderColor: border,
      lineColor: line,
      textColor: foreground,
      labelTextColor: foreground,
      nodeBorder: border,
      clusterBkg: tertiaryFill,
      clusterBorder: border,
      edgeLabelBackground: background,
      noteBkgColor: accentFill,
      noteTextColor: foreground,
      noteBorderColor: border,
      actorBkg: primaryFill,
      actorBorder: border,
      actorTextColor: foreground,
      actorLineColor: line,
      signalColor: line,
      signalTextColor: foreground,
      activationBkgColor: accentFill,
      activationBorderColor: accent,
      sequenceNumberColor: foreground,
      labelBackground: background,
      loopTextColor: foreground,
      altBackground: tertiaryFill,
      sectionBkgColor: primaryFill,
      sectionBkgColor2: secondaryFill,
      taskBkgColor: primaryFill,
      taskTextColor: foreground,
      taskBorderColor: border,
      gridColor: line,
      todayLineColor: accent,
      classText: foreground,
      fillType0: primaryFill,
      fillType1: secondaryFill,
      fillType2: tertiaryFill,
      fillType3: accentFill,
      fillType4: primaryFill,
      fillType5: secondaryFill,
      fillType6: tertiaryFill,
      fillType7: accentFill,
    },
  };
}

function enqueueMermaidRender<T>(run: () => Promise<T>): Promise<T> {
  const result = mermaidRenderQueue.then(run, run);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function getCachedMermaidSvg(key: string) {
  const svg = mermaidSvgCache.get(key);
  if (svg === undefined) return undefined;
  mermaidSvgCache.delete(key);
  mermaidSvgCache.set(key, svg);
  return svg;
}

function cacheMermaidSvg(key: string, svg: string) {
  mermaidSvgCache.delete(key);
  mermaidSvgCache.set(key, svg);
  while (mermaidSvgCache.size > MERMAID_SVG_CACHE_LIMIT) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (oldest === undefined) break;
    mermaidSvgCache.delete(oldest);
  }
}

async function waitForMermaidLayoutReady() {
  const fonts = document.fonts?.ready;
  if (fonts) {
    await Promise.race([fonts, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

export async function renderMermaidWithColdRetryForTests(
  mermaid: Mermaid,
  source: string,
  config: MermaidConfig
) {
  await waitForMermaidLayoutReady();
  mermaid.initialize(config);
  try {
    return await mermaid.render(`varro-mermaid-${++mermaidRenderSequence}`, source);
  } catch (firstError) {
    mermaid.initialize(config);
    try {
      await mermaid.parse(source);
    } catch {
      throw firstError;
    }
    await waitForMermaidLayoutReady();
    mermaid.initialize(config);
    return mermaid.render(`varro-mermaid-${++mermaidRenderSequence}`, source);
  }
}

function showMermaidFailure(diagram: HTMLElement, message: string) {
  const status = diagram.querySelector<HTMLElement>('.mermaid-diagram-status');
  if (status) status.textContent = message;
  diagram.querySelector<HTMLElement>('.mermaid-diagram-fallback')?.removeAttribute('hidden');
  diagram.dataset.mermaidHydrated = 'error';
}

function mountMermaidSvg(diagram: HTMLElement, svg: string) {
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-diagram-toolbar';
  toolbar.innerHTML = `<button type="button" data-mermaid-copy aria-label="Copy Mermaid source" title="Copy Mermaid source">${copySvg}</button><button type="button" data-mermaid-expand aria-label="Expand diagram" title="Expand diagram">${expandSvg}</button>`;
  const output = document.createElement('div');
  output.className = 'mermaid-diagram-output';
  output.innerHTML = svg;
  diagram.prepend(output);
  diagram.prepend(toolbar);
  diagram.querySelector('.mermaid-diagram-status')?.remove();
  diagram.dataset.mermaidHydrated = 'complete';
}

export function resetMermaidDiagramsForThemeForTests(root: HTMLElement | undefined) {
  if (!root) return;
  for (const diagram of root.querySelectorAll<HTMLElement>(
    '.mermaid-diagram[data-mermaid-source]'
  )) {
    diagram.querySelector('.mermaid-diagram-toolbar')?.remove();
    diagram.querySelector('.mermaid-diagram-output')?.remove();
    diagram.querySelector('.mermaid-diagram-status')?.remove();
    const status = document.createElement('div');
    status.className = 'mermaid-diagram-status';
    status.innerHTML = '<span>Rendering diagram...</span>';
    diagram.prepend(status);
    diagram.querySelector<HTMLElement>('.mermaid-diagram-fallback')?.setAttribute('hidden', '');
    delete diagram.dataset.mermaidHydrated;
  }
}

async function hydrateMermaidDiagrams(root: HTMLDivElement | undefined) {
  if (!root) return;

  const diagrams = Array.from(
    root.querySelectorAll<HTMLElement>(
      '.mermaid-diagram[data-mermaid-source]:not([data-mermaid-hydrated])'
    )
  );
  if (diagrams.length === 0) return;

  const pending: Array<{
    diagram: HTMLElement;
    source: string;
    config: MermaidConfig;
    cacheKey: string;
  }> = [];
  for (const diagram of diagrams) {
    const source = decodeCopyPayload(diagram.dataset.mermaidSource || '');
    const config = getMermaidThemeConfigForTests();
    const cacheKey = `${JSON.stringify(config)}\u0000${source}`;
    const cached = getCachedMermaidSvg(cacheKey);
    if (cached !== undefined) {
      mountMermaidSvg(diagram, cached);
    } else {
      pending.push({ diagram, source, config, cacheKey });
    }
  }
  if (pending.length === 0) return;

  let mermaid: Mermaid;
  try {
    ({ default: mermaid } = await import('mermaid'));
  } catch {
    for (const { diagram } of pending) {
      showMermaidFailure(diagram, 'Could not load diagram renderer. Showing Mermaid source.');
    }
    return;
  }
  for (const { diagram, source, config, cacheKey } of pending) {
    if (!diagram.isConnected || diagram.dataset.mermaidHydrated) continue;
    diagram.dataset.mermaidHydrated = 'loading';

    try {
      const sanitized = await enqueueMermaidRender(async () => {
        const cached = getCachedMermaidSvg(cacheKey);
        if (cached !== undefined) return cached;
        const { svg } = await renderMermaidWithColdRetryForTests(mermaid, source, config);
        const clean = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        cacheMermaidSvg(cacheKey, clean);
        return clean;
      });
      if (!diagram.isConnected) continue;
      mountMermaidSvg(diagram, sanitized);
    } catch {
      if (!diagram.isConnected) continue;
      showMermaidFailure(diagram, 'Could not render diagram. Showing Mermaid source.');
    }
  }
}

function hydrateRenderedMarkdown(root: HTMLDivElement | undefined, flags: MarkdownHydrationFlags) {
  if (flags.tables) applyTableColumnClasses(root);
  if (flags.copyButtons) applyCodeBlockCopyIcons(root);
  if (flags.mermaid) void hydrateMermaidDiagrams(root);
}

export function MarkdownRenderer(props: MarkdownProps) {
  // oxlint-disable-next-line no-unassigned-vars
  let ref: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let stableRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let tailRef: HTMLDivElement | undefined;

  const lw = () => props.lightweight ?? false;
  const [mermaidPreview, setMermaidPreview] = createSignal<{ svg: string } | null>(null);
  let appliedMermaidTheme = theme();

  function closeMermaidPreview() {
    if (!mermaidPreview()) return;
    setMermaidPreview(null);
    postMessage({ type: 'vscode/mermaid-preview', payload: { open: false } });
  }

  let pendingContent: string | null = null;
  let rafId: number | null = null;
  let idleHighlightId: IdleWorkHandle | null = null;
  let hasProcessedStreamingUpdate = false;
  const initialSegments = getMarkdownRenderSegments(props.content || '', !!props.cacheByContent);
  let lastAppliedScanState = initialSegments.scanState;
  let lastAppliedCacheByContent = !!props.cacheByContent;
  let lastAppliedLightweight = lw();
  let lastAppliedWorkspacePath = state.editorContext.workspacePath || '';
  let lastAppliedSessionContextKey = getSessionReferenceContextKey(props.content || '');
  let lastAppliedCodeHighlighterVersion = codeHighlighterVersion();
  let lastAppliedStableContent = initialSegments.stableContent;
  let lastAppliedTailContent = initialSegments.tailContent;
  let lastAppliedStableHtml = initialSegments.stableContent
    ? parseMarkdown(initialSegments.stableContent, {
        cacheByContent: false,
        disablePathLinkify: lw(),
        disableCodeHighlighting: lw(),
        allowMermaidHydration: lw(),
      })
    : '';
  let lastAppliedTailHtml = parseMarkdown(initialSegments.tailContent, {
    cacheByContent: initialSegments.stableContent.length === 0 && !!props.cacheByContent,
    disablePathLinkify: !props.cacheByContent || lw(),
    disableCodeHighlighting: initialSegments.hasUnclosedFence || lw(),
    allowMermaidHydration: lw() && !initialSegments.hasUnclosedFence,
  });
  let lastAppliedStableHydrationFlags = getMarkdownHydrationFlags(lastAppliedStableHtml);
  let lastAppliedTailHydrationFlags = getMarkdownHydrationFlags(lastAppliedTailHtml);
  let lastAppliedStableContentWasAppendOnlySafe = isAppendOnlySafeMarkdown(
    initialSegments.stableContent
  );

  const [stableHtml, setStableHtml] = createSignal(lastAppliedStableHtml);
  const [tailHtml, setTailHtml] = createSignal(lastAppliedTailHtml);

  function scheduleDeferredTailHighlight(
    content: string,
    workspacePath: string,
    sessionContextKey: string
  ) {
    if (lw()) return;
    cancelIdleWork(idleHighlightId);
    idleHighlightId = requestIdleWork(() => {
      idleHighlightId = null;
      if (pendingContent !== null) return;
      if (workspacePath !== lastAppliedWorkspacePath) return;
      if (sessionContextKey !== lastAppliedSessionContextKey) return;
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
      const isLightweight = lw();
      // Completion can briefly regress while the final message events reconcile.
      // Keep final rendering enabled once observed so links and highlighting do not flicker.
      const cacheByContent = lastAppliedCacheByContent || !!props.cacheByContent;
      const renderModeChanged =
        cacheByContent !== lastAppliedCacheByContent || isLightweight !== lastAppliedLightweight;
      const preserveStreamingSegments = cacheByContent && lastAppliedScanState !== null;
      const segments = preserveStreamingSegments
        ? getStreamingMarkdownSegments(content, lastAppliedScanState)
        : getMarkdownRenderSegments(content, cacheByContent, lastAppliedScanState);
      const workspacePath = state.editorContext.workspacePath || '';
      const sessionContextKey = getSessionReferenceContextKey(content);
      const currentCodeHighlighterVersion = codeHighlighterVersion();
      const codeHighlighterChanged =
        currentCodeHighlighterVersion !== lastAppliedCodeHighlighterVersion;
      const stableContentChanged =
        workspacePath !== lastAppliedWorkspacePath ||
        sessionContextKey !== lastAppliedSessionContextKey ||
        segments.stableContent !== lastAppliedStableContent ||
        renderModeChanged ||
        codeHighlighterChanged;
      const tailContentChanged =
        workspacePath !== lastAppliedWorkspacePath ||
        sessionContextKey !== lastAppliedSessionContextKey ||
        segments.tailContent !== lastAppliedTailContent ||
        renderModeChanged ||
        codeHighlighterChanged;
      const appendOnlyStableDelta =
        !renderModeChanged &&
        workspacePath === lastAppliedWorkspacePath &&
        sessionContextKey === lastAppliedSessionContextKey
          ? getAppendOnlyStableDelta(
              lastAppliedStableContent,
              segments.stableContent,
              lastAppliedStableContentWasAppendOnlySafe
            )
          : null;
      const nextStableHtml =
        segments.stableContent.length === 0
          ? ''
          : stableContentChanged
            ? appendOnlyStableDelta
              ? `${lastAppliedStableHtml}${parseMarkdown(appendOnlyStableDelta, {
                  cacheByContent: false,
                  disablePathLinkify: isLightweight,
                  disableCodeHighlighting: isLightweight,
                  allowMermaidHydration: isLightweight,
                })}`
              : parseMarkdown(segments.stableContent, {
                  cacheByContent: false,
                  disablePathLinkify: isLightweight,
                  disableCodeHighlighting: isLightweight,
                  allowMermaidHydration: isLightweight,
                })
            : lastAppliedStableHtml;
      const shouldDeferTailHighlight =
        !isLightweight &&
        hasProcessedStreamingUpdate &&
        tailContentChanged &&
        !cacheByContent &&
        !segments.hasUnclosedFence &&
        hasCompletedHighlightableFence(segments.tailContent);
      const nextTailHtml = tailContentChanged
        ? parseMarkdown(segments.tailContent, {
            cacheByContent: segments.stableContent.length === 0 && cacheByContent,
            disablePathLinkify: !cacheByContent || isLightweight,
            disableCodeHighlighting:
              segments.hasUnclosedFence || shouldDeferTailHighlight || isLightweight,
            allowMermaidHydration: isLightweight && !segments.hasUnclosedFence,
          })
        : lastAppliedTailHtml;

      const stableChanged = nextStableHtml !== lastAppliedStableHtml;
      const tailChanged = nextTailHtml !== lastAppliedTailHtml;
      if (stableChanged) {
        lastAppliedStableContent = segments.stableContent;
        lastAppliedStableHtml = nextStableHtml;
        lastAppliedStableContentWasAppendOnlySafe = appendOnlyStableDelta
          ? true
          : isAppendOnlySafeMarkdown(segments.stableContent);
        lastAppliedStableHydrationFlags = getMarkdownHydrationFlags(nextStableHtml);
        setStableHtml(nextStableHtml);
      } else if (stableContentChanged) {
        lastAppliedStableContent = segments.stableContent;
        lastAppliedStableContentWasAppendOnlySafe = isAppendOnlySafeMarkdown(
          segments.stableContent
        );
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
      lastAppliedSessionContextKey = sessionContextKey;
      lastAppliedCodeHighlighterVersion = currentCodeHighlighterVersion;
      lastAppliedScanState = segments.scanState;
      lastAppliedCacheByContent = cacheByContent;
      lastAppliedLightweight = isLightweight;
      hasProcessedStreamingUpdate = true;

      if (shouldDeferTailHighlight) {
        scheduleDeferredTailHighlight(segments.tailContent, workspacePath, sessionContextKey);
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
    const cacheByContent = !!props.cacheByContent;
    const isLightweight = lw();
    const workspacePath = state.editorContext.workspacePath;
    const sessionContextKey = getSessionReferenceContextKey(content);
    const highlighterVersion = codeHighlighterVersion();
    if (rafId !== null) {
      pendingContent = content;
      return;
    }
    pendingContent = content;
    rafId = requestAnimationFrame(flushPending);
    void workspacePath;
    void sessionContextKey;
    void highlighterVersion;
    void cacheByContent;
    void isLightweight;
  });

  createEffect(() => {
    const nextTheme = theme();
    if (nextTheme === appliedMermaidTheme) return;
    appliedMermaidTheme = nextTheme;
    closeMermaidPreview();
    resetMermaidDiagramsForThemeForTests(stableRef);
    resetMermaidDiagramsForThemeForTests(tailRef);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void hydrateMermaidDiagrams(stableRef);
        void hydrateMermaidDiagrams(tailRef);
      });
    });
  });

  const copyTimeouts = new Set<ReturnType<typeof setTimeout>>();

  onCleanup(() => {
    if (mermaidPreview()) {
      postMessage({ type: 'vscode/mermaid-preview', payload: { open: false } });
    }
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
    const mermaidCopy = (e.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-mermaid-copy]'
    );
    if (mermaidCopy) {
      const diagram = mermaidCopy.closest<HTMLElement>('.mermaid-diagram');
      const source = decodeCopyPayload(diagram?.dataset.mermaidSource || '');
      if (source) writeClipboard(source);
      mermaidCopy.innerHTML = checkSvg;
      const tid = setTimeout(() => {
        copyTimeouts.delete(tid);
        mermaidCopy.innerHTML = copySvg;
      }, 1500);
      copyTimeouts.add(tid);
      return;
    }

    const mermaidExpand = (e.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-mermaid-expand]'
    );
    if (mermaidExpand) {
      const diagram = mermaidExpand.closest<HTMLElement>('.mermaid-diagram');
      const svg = diagram?.querySelector<SVGSVGElement>('.mermaid-diagram-output > svg');
      const source = decodeCopyPayload(diagram?.dataset.mermaidSource || '');
      if (!svg || !source) return;
      setMermaidPreview({ svg: svg.outerHTML });
      postMessage({ type: 'vscode/mermaid-preview', payload: { open: true } });
      return;
    }

    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]');
    if (btn) {
      const block = btn.closest('.interactive-result-code-block');
      const code = block?.querySelector('code');
      if (!code) return;
      const copyText = sanitizeCopyText(
        btn.dataset.copyText ? decodeCopyPayload(btn.dataset.copyText) : (code.textContent ?? '')
      );
      if (!copyText) return;
      writeClipboard(copyText);
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
      if (link.classList.contains('is-unavailable')) return;
      try {
        const payload = JSON.parse(link.dataset.file || '{}');
        void openPathWithResult({ path: payload.path, line: payload.line, kind: 'file' })
          .then((status) => {
            if (status === 'opened') return;
            link.classList.add('is-unavailable');
            link.setAttribute('aria-disabled', 'true');
            link.removeAttribute('href');
            const label = link.getAttribute('aria-label') || link.textContent || 'file';
            const message = `File not found: ${label}`;
            link.title = message;
            showSessionActionFeedback(message, 'warning');
          })
          .catch(() => showSessionActionFeedback('Could not open file', 'warning'));
      } catch (err) {
        logWarn('markdown file-path-link payload parse', err);
      }
      return;
    }

    const sessionLink = (e.target as HTMLElement).closest<HTMLAnchorElement>(
      'a.session-reference-link'
    );
    if (sessionLink?.dataset.sessionId) {
      e.preventDefault();
      void selectSession(sessionLink.dataset.sessionId);
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
        void openPathWithResult({ path: payload.path, line: payload.line, kind: 'file' });
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
    <>
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
      <MermaidPreviewOverlay preview={mermaidPreview()} onClose={closeMermaidPreview} />
    </>
  );
}

function MermaidPreviewOverlay(props: { preview: { svg: string } | null; onClose: () => void }) {
  createEffect(() => {
    if (!props.preview) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener('keydown', handleKeydown);
    onCleanup(() => window.removeEventListener('keydown', handleKeydown));
  });

  return (
    <Portal>
      <Show when={props.preview}>
        {(preview) => (
          <div
            ref={(element) => onCleanup(trapModalFocus(element))}
            class="mermaid-preview-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Mermaid diagram preview"
            onClick={props.onClose}
          >
            <div class="mermaid-preview-toolbar">
              <button
                type="button"
                aria-label="Close diagram preview"
                title="Close diagram preview"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClose();
                }}
                innerHTML={closeSvg}
              />
            </div>
            <div
              class="mermaid-preview-canvas"
              onClick={(event) => event.stopPropagation()}
              innerHTML={preview().svg}
            />
          </div>
        )}
      </Show>
    </Portal>
  );
}
