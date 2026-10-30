import { afterEach, describe, expect, it } from 'vitest';
import { selectionMarkdown } from './selection-markdown';

let root: HTMLDivElement | undefined;

afterEach(() => root?.remove());

function setup(html: string) {
  root = document.createElement('div');
  root.innerHTML = `<div class="interactive-list"><div class="interactive-item-container"><div class="rendered-markdown">${html}</div></div></div>`;
  document.body.append(root);
  return root.querySelector<HTMLElement>('.rendered-markdown')!;
}

function capture(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return selectionMarkdown(range);
}

describe('selection markdown', () => {
  it('preserves headings, paragraphs, inline formatting, and literal Markdown characters', () => {
    const markdown = setup(
      '<h2>Title</h2>\n<p>A <strong>bold</strong> and <em>italic</em> <del>old</del> [label].</p>\n<p>Next</p>'
    );
    expect(capture(markdown)).toBe(
      '## Title\n\nA **bold** and *italic* ~~old~~ \\[label\\].\n\nNext'
    );
  });

  it('preserves the formatting around a partially selected text node', () => {
    const markdown = setup('<p>Before <strong>selected words</strong> after</p>');
    const text = markdown.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 8);
    expect(selectionMarkdown(range)).toBe('**lected**');
  });

  it('copies only the selected parts across formatted nodes', () => {
    const markdown = setup(
      '<p>Before <strong>bold words</strong> then <em>italic words</em> after</p>'
    );
    const range = document.createRange();
    range.setStart(markdown.querySelector('strong')!.firstChild!, 5);
    range.setEnd(markdown.querySelector('em')!.firstChild!, 6);
    expect(selectionMarkdown(range)).toBe('**words** then *italic*');
  });

  it('keeps lists, nesting, ordered starts, and task states', () => {
    const markdown = setup(
      '<ul><li>First<ul><li>Nested</li></ul></li><li><span class="markdown-task-checkbox markdown-task-checkbox-checked"><svg></svg></span>Done</li></ul><ol start="3"><li>Third</li><li>Fourth</li></ol>'
    );
    expect(capture(markdown)).toBe('- First\n  - Nested\n- [x] Done\n\n3. Third\n4. Fourth');
  });

  it('retains list context when only one item is selected', () => {
    const markdown = setup('<ul><li>First</li><li><strong>Second</strong></li></ul>');
    expect(capture(markdown.querySelectorAll('li')[1]!)).toBe('- **Second**');
  });

  it('preserves link destinations and ignores injected link icons', () => {
    const markdown = setup(
      '<p><a href="https://example.com/a(b)"><span><svg aria-hidden="true"><title>Icon</title></svg>Exam</span>ple</a> <a data-inferred-code-path href="/project/app.ts">app.ts</a></p>'
    );
    expect(capture(markdown)).toBe('[Example](<https://example.com/a(b)>) `app.ts`');
  });

  it('retains the original number of a selected ordered list item', () => {
    const markdown = setup('<ol start="3"><li>Third</li><li>Fourth</li><li>Fifth</li></ol>');
    expect(capture(markdown.querySelectorAll('li')[1]!)).toBe('4. Fourth');
    const range = document.createRange();
    range.setStart(markdown.querySelectorAll('li')[1]!.firstChild!, 0);
    range.setEnd(markdown.querySelectorAll('li')[2]!.firstChild!, 5);
    expect(selectionMarkdown(range)).toBe('4. Fourth\n5. Fifth');
  });

  it('does not turn literal list markers into lists', () => {
    const markdown = setup('<p>- literal</p><p>1. literal</p>');
    expect(capture(markdown)).toBe('\\- literal\n\n1\\. literal');
  });

  it('preserves a partial link selection without copying its unselected label', () => {
    const markdown = setup('<a href="https://example.com">Example</a>');
    const range = document.createRange();
    range.setStart(markdown.querySelector('a')!.firstChild!, 2);
    range.setEnd(markdown.querySelector('a')!.firstChild!, 5);
    expect(selectionMarkdown(range)).toBe('[amp](<https://example.com>)');
  });

  it('copies selected code with its language, without the header or copy button', () => {
    const markdown = setup(
      '<div class="interactive-result-code-block" data-lang="ts"><div class="code-block-header">ts<button>Copy</button></div><pre><code><span>const</span> a = `value`;\n\n\nnext();</code></pre></div>'
    );
    expect(capture(markdown)).toBe('```ts\nconst a = `value`;\n\n\nnext();\n```');
    expect(capture(markdown.querySelector('code span')!)).toBe('```ts\nconst\n```');
  });

  it('uses fences that cannot be closed by selected code', () => {
    const markdown = setup('<p><code>`value`</code></p><pre><code>```\ncode</code></pre>');
    expect(capture(markdown)).toBe('`` `value` ``\n\n````\n```\ncode\n````');
  });

  it('preserves blockquotes, line breaks, and tables', () => {
    const markdown = setup(
      '<blockquote><p>Quote<br>next</p></blockquote><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td><strong>B</strong></td></tr></tbody></table>'
    );
    expect(capture(markdown)).toBe(
      '> Quote  \n> next\n\n| Name | Value |\n| --- | --- |\n| A | **B** |'
    );
  });

  it('preserves spacing across stable and streaming-tail segments', () => {
    const markdown = setup(
      '<div data-markdown-segment="stable"><p>First</p></div><div data-markdown-segment="tail"><p>Still <strong>streaming</strong></p></div>'
    );
    expect(capture(markdown)).toBe('First\n\nStill **streaming**');
  });

  it('captures selections spanning multiple message rows', () => {
    const markdown = setup('<p><strong>First</strong></p>');
    const row = root!.querySelector('.interactive-item-container')!;
    row.insertAdjacentHTML(
      'afterend',
      '<div class="interactive-item-container"><div class="rendered-markdown"><p><em>Second</em></p></div></div>'
    );
    const range = document.createRange();
    range.setStart(markdown.querySelector('strong')!.firstChild!, 0);
    range.setEnd(root!.querySelector('em')!.firstChild!, 6);
    expect(selectionMarkdown(range)).toBe('**First**\n\n*Second*');
  });

  it('does not offer Markdown for selections outside rendered Markdown', () => {
    const markdown = setup('<p>Text</p>');
    markdown.className = 'tool-output';
    expect(capture(markdown)).toBeNull();
  });
});
