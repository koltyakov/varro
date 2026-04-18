import { createMemo } from 'solid-js';
import { marked } from 'marked';

interface MarkdownProps {
  content: string;
}

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const langLabel = lang
    ? `<span class="code-block-lang">${lang}</span>`
    : '';
  const copyBtn = `<button class="code-block-copy-btn" onclick="(function(btn){var code=btn.closest('.interactive-result-code-block').querySelector('code');navigator.clipboard.writeText(code.textContent);btn.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBox=\\'0 0 16 16\\' fill=\\'currentColor\\'><path d=\\'M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z\\'/></svg>';setTimeout(function(){btn.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBox=\\'0 0 16 16\\' fill=\\'currentColor\\'><path d=\\'M13.5 2h-8a.5.5 0 00-.5.5V5H3.5a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V11h1.5a.5.5 0 00.5-.5v-8a.5.5 0 00-.5-.5zm-2 11h-7V6H6v4.5a.5.5 0 00.5.5H11v2zm2-3H7V3h7v7z\\'/></svg>';},1500);})(this)" title="Copy code"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 2h-8a.5.5 0 00-.5.5V5H3.5a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V11h1.5a.5.5 0 00.5-.5v-8a.5.5 0 00-.5-.5zm-2 11h-7V6H6v4.5a.5.5 0 00.5.5H11v2zm2-3H7V3h7v7z"/></svg></button>`;
  return `<div class="interactive-result-code-block"><div class="code-block-header">${langLabel}${copyBtn}</div><pre class="code-block"><code>${escaped}</code></pre></div>`;
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: false,
});

export function MarkdownRenderer(props: MarkdownProps) {
  const html = createMemo(() => {
    try {
      return marked.parse(props.content || '') as string;
    } catch {
      return props.content;
    }
  });

  return <div class="rendered-markdown" innerHTML={html()} />;
}
