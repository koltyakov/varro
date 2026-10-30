function escapeText(text: string): string {
  return text
    .replace(/([\\`*_[\]<>#|~])/g, '\\$1')
    .replace(/^(\s*)([-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*\d+)\.(?=\s)/, '$1\\.');
}

function inlineCode(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const padding = /^`|`$|^ .* $/.test(text) ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function codeBlock(text: string, language: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(2, ...runs.map((run) => run.length)) + 1);
  return `\n\n${fence}${language.replace(/\s.*/, '')}\n${text.replace(/\n$/, '')}\n${fence}\n\n`;
}

function children(node: Node): string {
  return Array.from(node.childNodes, toMarkdown).reduce((result, part) => {
    const trailing = result.match(/\n\s*$/)?.[0];
    const leading = part.match(/^\s*\n/)?.[0];
    if (trailing && !part.trim()) return result;
    if (trailing && leading) {
      const count = Math.max(trailing.split('\n').length - 1, leading.split('\n').length - 1);
      return `${result.trimEnd()}${'\n'.repeat(count)}${part.trimStart()}`;
    }
    return result + part;
  }, '');
}

function toMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return escapeText((node.textContent ?? '').replace(/\s+/g, ' '));
  if (!(node instanceof Element)) return children(node);
  if (node.matches('button, svg, [hidden], [aria-hidden="true"], .code-block-header')) return '';
  if (node.matches('.markdown-task-checkbox')) {
    return node.classList.contains('markdown-task-checkbox-checked') ? '[x] ' : '[ ] ';
  }
  if (node.matches('.interactive-result-code-block, pre')) {
    const code = node.querySelector('code');
    const language =
      node.getAttribute('data-lang') ?? code?.className.match(/language-(\S+)/)?.[1] ?? '';
    return codeBlock(code?.textContent ?? node.textContent ?? '', language);
  }
  const content = children(node);
  const wrapped = (marker: string) => {
    const trimmed = content.trim();
    if (!trimmed) return content;
    return `${content.match(/^\s*/)?.[0] ?? ''}${marker}${trimmed}${marker}${content.match(/\s*$/)?.[0] ?? ''}`;
  };
  switch (node.tagName.toLowerCase()) {
    case 'strong':
    case 'b':
      return wrapped('**');
    case 'em':
    case 'i':
      return wrapped('*');
    case 'del':
    case 's':
      return wrapped('~~');
    case 'code':
      return inlineCode(node.textContent ?? '');
    case 'a': {
      if (node.hasAttribute('data-inferred-code-path')) return inlineCode(node.textContent ?? '');
      const href = node.getAttribute('href');
      if (!href || !content.trim()) return content;
      const destination = href.replace(/\\/g, '%5C').replace(/</g, '%3C').replace(/>/g, '%3E');
      return `[${content}](<${destination}>)`;
    }
    case 'img':
      return `![${escapeText(node.getAttribute('alt') ?? '')}](<${node.getAttribute('src') ?? ''}>)`;
    case 'br':
      return '  \n';
    case 'hr':
      return '\n\n---\n\n';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n\n${'#'.repeat(Number(node.tagName[1]))} ${content.trim()}\n\n`;
    case 'p':
      return `\n\n${content.trim()}\n\n`;
    case 'blockquote':
      return `\n\n${content
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    case 'ul':
    case 'ol': {
      const start = Number(node.getAttribute('start') ?? 1);
      const items = Array.from(node.children).filter((item) => item.tagName === 'LI');
      const spacing = node.parentElement?.closest('li') ? '\n' : '\n\n';
      return `${spacing}${items
        .map((item, index) => {
          const marker = node.tagName === 'OL' ? `${start + index}. ` : '- ';
          const lines = children(item).trim().split('\n');
          return marker + lines.join(`\n${' '.repeat(marker.length)}`);
        })
        .join('\n')}${spacing}`;
    }
    case 'table': {
      const rows = Array.from(node.querySelectorAll('tr')).map((row) =>
        Array.from(row.children, (cell) => children(cell).trim().replace(/\n+/g, '<br>'))
      );
      if (!rows.length) return '';
      const lines = rows.map((cells) => `| ${cells.join(' | ')} |`);
      lines.splice(1, 0, `| ${rows[0]!.map(() => '---').join(' | ')} |`);
      return `\n\n${lines.join('\n')}\n\n`;
    }
    default:
      return node.matches('.rendered-markdown, .interactive-item-container')
        ? `\n\n${content.trim()}\n\n`
        : content;
  }
}

function preserveOrderedStart(source: Element, clone: Element, range: Range): void {
  const items = Array.from(source.children).filter((item) => item.tagName === 'LI');
  const first = items.findIndex((item) => range.intersectsNode(item));
  if (first >= 0)
    clone.setAttribute('start', String(Number(source.getAttribute('start') ?? 1) + first));
}

/** Capture only the selected DOM, with the ancestors needed to retain Markdown formatting. */
export function selectionMarkdown(range: Range): string | null {
  const common = range.commonAncestorContainer;
  let ancestor = common instanceof Element ? common : common.parentElement;
  const selected = range.cloneContents();
  const inMarkdown =
    ancestor?.closest('.rendered-markdown') || selected.querySelector('.rendered-markdown');
  if (!inMarkdown) return null;

  const sourceLists = Array.from(ancestor?.querySelectorAll('ol') ?? []).filter((list) =>
    range.intersectsNode(list)
  );
  Array.from(selected.querySelectorAll('ol')).forEach((list, index) => {
    const source = sourceLists[index];
    if (source) preserveOrderedStart(source, list, range);
  });
  let fragment: Node = selected;
  // cloneContents omits the common ancestor, even when selecting text inside a link or list item.
  while (ancestor && !ancestor.matches('.interactive-item-container, .interactive-list')) {
    const wrapper = ancestor.cloneNode(false);
    if (ancestor.tagName === 'OL' && wrapper instanceof Element)
      preserveOrderedStart(ancestor, wrapper, range);
    wrapper.appendChild(fragment);
    fragment = wrapper;
    ancestor = ancestor.parentElement;
  }
  return toMarkdown(fragment).trim() || null;
}
