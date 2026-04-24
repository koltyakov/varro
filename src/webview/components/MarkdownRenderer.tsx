import { createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { marked } from 'marked';
import { postMessage } from '../lib/bridge';
import { state } from '../lib/state';
import { formatDisplayPath, normalizePath } from '../lib/path-display';
import { formatCommandDisplay } from '../lib/command-display';

interface MarkdownProps {
  content: string;
}

const copySvg =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h1V2.5a.5.5 0 01.5-.5h8a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H12v1h1.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 1h-8A1.5 1.5 0 004 2.5V4zm-2 1.5A1.5 1.5 0 013.5 4h8A1.5 1.5 0 0113 5.5v8a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 012 13.5v-8zM3.5 5a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5v-8a.5.5 0 00-.5-.5h-8z"/></svg>';
const checkSvg =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';

const renderer = new marked.Renderer();
const SHELL_LANGS = new Set(['', 'bash', 'console', 'shell', 'sh', 'zsh']);
const COMPACT_FIRST_COLUMN_HEADERS = new Set(['#', 'no', 'no.', 'num', 'id']);
const ALLOWED_HTML_TAGS = new Set([
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
]);
const STRIP_HTML_TAGS = new Set([
  'base',
  'iframe',
  'img',
  'link',
  'meta',
  'object',
  'script',
  'style',
]);
const GLOBAL_ALLOWED_ATTRIBUTES = new Set(['aria-hidden', 'aria-label', 'class', 'role', 'title']);
const TAG_ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['data-external', 'data-file', 'href']),
  button: new Set(['data-copy', 'data-copy-text', 'type']),
  div: new Set(['data-lang']),
  line: new Set([
    'stroke',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-width',
    'x1',
    'x2',
    'y1',
    'y2',
  ]),
  path: new Set(['d', 'fill', 'stroke', 'stroke-linecap', 'stroke-linejoin', 'stroke-width']),
  polyline: new Set([
    'fill',
    'points',
    'stroke',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-width',
  ]),
  svg: new Set([
    'fill',
    'height',
    'stroke',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-width',
    'viewBox',
    'width',
  ]),
};
const CODE_BLOCK_CACHE_LIMIT = 100;
const codeBlockHtmlCache = new Map<string, string>();

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const normalizedText = SHELL_LANGS.has((lang || '').toLowerCase())
    ? formatCommandDisplay(text, state.editorContext.workspacePath)
    : text;
  const cacheKey = `${lang || ''}\u0000${normalizedText}`;
  const cached = codeBlockHtmlCache.get(cacheKey);
  if (cached) {
    codeBlockHtmlCache.delete(cacheKey);
    codeBlockHtmlCache.set(cacheKey, cached);
    return cached;
  }
  const escaped = normalizedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const copyPayload = encodeCopyPayload(normalizedText);
  const langLabel = lang ? `<span class="code-block-lang">${lang}</span>` : '';
  const copyBtn =
    `<button type="button" class="code-block-copy-btn" data-copy data-copy-text="${copyPayload}" aria-label="Copy code" title="Copy code">` +
    copySvg +
    '</button>';
  const langAttr = lang ? ` data-lang="${lang.replace(/"/g, '&quot;')}"` : '';
  const html = `<div class="interactive-result-code-block"${langAttr}><div class="code-block-header">${langLabel}${copyBtn}</div><pre class="code-block"><code>${escaped}</code></pre></div>`;
  codeBlockHtmlCache.set(cacheKey, html);
  if (codeBlockHtmlCache.size > CODE_BLOCK_CACHE_LIMIT) {
    const oldest = codeBlockHtmlCache.keys().next().value;
    if (oldest) codeBlockHtmlCache.delete(oldest);
  }
  return html;
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
const ANCHOR_RE = /(<a[\s\S]*?<\/a>)/gi;
const SVG_RE = /(<svg[\s\S]*?<\/svg>)/gi;
const BUTTON_RE = /(<button[\s\S]*?<\/button>)/gi;

function isLocalFileHref(href: string | null): boolean {
  if (!href) return false;
  if (href.startsWith('#')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(href);
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
  const template = document.createElement('template');
  template.innerHTML = html;

  for (const element of Array.from(
    template.content.querySelectorAll<HTMLElement | SVGElement>('*')
  )) {
    const tag = element.tagName.toLowerCase();

    if (!ALLOWED_HTML_TAGS.has(tag)) {
      if (STRIP_HTML_TAGS.has(tag)) {
        element.remove();
        continue;
      }
      const text = element.textContent || '';
      element.replaceWith(document.createTextNode(text));
      continue;
    }

    const allowedAttributes = TAG_ALLOWED_ATTRIBUTES[tag];
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style') {
        element.removeAttribute(attr.name);
        continue;
      }

      if (!GLOBAL_ALLOWED_ATTRIBUTES.has(name) && !allowedAttributes?.has(name)) {
        element.removeAttribute(attr.name);
      }
    }

    if (element instanceof HTMLAnchorElement) {
      sanitizeAnchorHref(element);
    }
  }

  return template.innerHTML;
}

function linkifyPaths(html: string): string {
  const preserved: string[] = [];
  let idx = 0;
  const placeholder = (_m: string) => `\x00${idx++}\x00`;
  const protect = (re: RegExp) => {
    html = html.replace(re, (m) => {
      preserved.push(m);
      return placeholder(m);
    });
  };

  protect(SVG_RE);
  protect(BUTTON_RE);
  protect(ANCHOR_RE);

  html = html.replace(FILE_PATH_RE, (full, path: string) => {
    const link = buildFileLink(path);
    if (!link) return full;
    return full.replace(
      path,
      `<a href="${link.href}" class="file-path-link" data-file="${link.payload}">${link.label}</a>`
    );
  });

  for (let i = preserved.length - 1; i >= 0; i--) {
    html = html.replace(`\x00${i}\x00`, preserved[i]);
  }
  return html;
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
    button.innerHTML = copySvg;
  }
}

export function MarkdownRenderer(props: MarkdownProps) {
  // oxlint-disable-next-line no-unassigned-vars
  let ref: HTMLDivElement | undefined;

  let pendingContent: string | null = null;
  let rafId: number | null = null;
  let lastAppliedHtml = '';

  const [renderedHtml, setRenderedHtml] = createSignal(parseMarkdown(props.content || ''));

  function parseMarkdown(content: string): string {
    try {
      const parsed = marked.parse(content) as string;
      return sanitizeHtml(linkifyPaths(parsed));
    } catch {
      return `<p>${escapeHtml(content)}</p>`;
    }
  }

  function flushPending() {
    rafId = null;
    if (pendingContent !== null) {
      const content = pendingContent;
      pendingContent = null;
      const nextHtml = parseMarkdown(content);
      if (nextHtml !== lastAppliedHtml) {
        lastAppliedHtml = nextHtml;
        setRenderedHtml(nextHtml);
      }
      queueMicrotask(() => {
        applyTableColumnClasses(ref);
        applyCodeBlockCopyIcons(ref);
      });
    }
  }

  lastAppliedHtml = renderedHtml();

  createEffect(() => {
    const content = props.content || '';
    if (rafId !== null) {
      pendingContent = content;
      return;
    }
    pendingContent = content;
    rafId = requestAnimationFrame(flushPending);
  });

  const copyTimeouts = new Set<ReturnType<typeof setTimeout>>();

  onCleanup(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (const id of copyTimeouts) clearTimeout(id);
    copyTimeouts.clear();
  });

  function handleClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]');
    if (btn) {
      const block = btn.closest('.interactive-result-code-block');
      const code = block?.querySelector('code');
      if (!code) return;
      const copyText = btn.dataset.copyText
        ? decodeCopyPayload(btn.dataset.copyText)
        : (code.textContent ?? '');
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
  });
  onCleanup(() => {
    ref?.removeEventListener('click', handleClick);
  });

  return <div ref={ref} class="rendered-markdown" innerHTML={renderedHtml()} />;
}
