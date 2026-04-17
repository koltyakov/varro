import { Show, createSignal, createMemo, onMount } from "solid-js"
import { marked } from "marked"

interface MarkdownProps {
  content: string
}

const renderer = new marked.Renderer()

renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return `<pre class="code-block overflow-x-auto rounded bg-vscode-input-bg p-2"><code${lang ? ` class="language-${lang}"` : ""}>${escaped}</code></pre>`
}

marked.setOptions({
  renderer,
  gfm: true,
  breaks: false,
})

export function MarkdownRenderer(props: MarkdownProps) {
  const html = createMemo(() => {
    try {
      return marked.parse(props.content || "") as string
    } catch {
      return props.content
    }
  })

  return <div class="markdown-content" innerHTML={html()} />
}
