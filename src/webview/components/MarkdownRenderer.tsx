import { createMemo, onMount, onCleanup } from 'solid-js';
import { marked } from 'marked';
import { postMessage } from '../lib/bridge';

interface MarkdownProps {
  content: string;
}

const copySvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h1V2.5a.5.5 0 01.5-.5h8a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H12v1h1.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 1h-8A1.5 1.5 0 004 2.5V4zm-2 1.5A1.5 1.5 0 013.5 4h8A1.5 1.5 0 0113 5.5v8a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 012 13.5v-8zM3.5 5a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5v-8a.5.5 0 00-.5-.5h-8z"/></svg>';
const checkSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const langLabel = lang
    ? `<span class="code-block-lang">${lang}</span>`
    : '';
  const copyBtn = `<button class="code-block-copy-btn" data-copy title="Copy code">${copySvg}</button>`;
  return `<div class="interactive-result-code-block"><div class="code-block-header">${langLabel}${copyBtn}</div><pre class="code-block"><code>${escaped}</code></pre></div>`;
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: false,
});

const FILE_PATH_RE = /(?:^|[\s(])(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.[\w]+(?:\:\d+(?:-\d+)?)?)(?=[\s),.]|$)/g;
const CODE_BLOCK_RE = /(`{1,3}[\s\S]*?`{1,3}|<code[\s\S]*?<\/code>)/gi;
const ANCHOR_RE = /(<a[\s\S]*?<\/a>)/gi;

function linkifyPaths(html: string): string {
  const preserved: string[] = [];
  let idx = 0;
  const placeholder = (m: string) => `\x00${idx++}\x00`;
  const protect = (re: RegExp) => { html = html.replace(re, (m) => { preserved.push(m); return placeholder(m); }); };

  protect(ANCHOR_RE);

  html = html.replace(FILE_PATH_RE, (full, path: string) => {
    const lineMatch = path.match(/^(.+?):(\d+(?:-\d+)?)$/);
    let filePath: string;
    let line: number | undefined;
    if (lineMatch) {
      filePath = lineMatch[1];
      line = parseInt(lineMatch[2], 10);
    } else {
      filePath = path;
    }
    const payload = line != null ? `{&quot;path&quot;:&quot;${filePath}&quot;,&quot;line&quot;:${line}}` : `{&quot;path&quot;:&quot;${filePath}&quot;}`;
    return full.replace(path, `<a href="#" class="file-path-link" data-file='${payload}'>${path}</a>`);
  });

  for (let i = preserved.length - 1; i >= 0; i--) {
    html = html.replace(`\x00${i}\x00`, preserved[i]);
  }
  return html;
}

export function MarkdownRenderer(props: MarkdownProps) {
  let ref: HTMLDivElement | undefined;

  const html = createMemo(() => {
    try {
      const parsed = marked.parse(props.content || '') as string;
      return linkifyPaths(parsed);
    } catch {
      return props.content;
    }
  });

  function handleClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]');
    if (btn) {
      const block = btn.closest('.interactive-result-code-block');
      const code = block?.querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent || '');
      btn.innerHTML = checkSvg;
      setTimeout(() => { btn.innerHTML = copySvg; }, 1500);
      return;
    }

    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.file-path-link');
    if (link) {
      e.preventDefault();
      try {
        const payload = JSON.parse(link.dataset.file || '{}');
        postMessage({ type: 'vscode/open', payload: { path: payload.path, line: payload.line } });
      } catch {}
    }
  }

  onMount(() => {
    ref?.addEventListener('click', handleClick);
  });
  onCleanup(() => {
    ref?.removeEventListener('click', handleClick);
  });

  return <div ref={ref} class="rendered-markdown" innerHTML={html()} />;
}
