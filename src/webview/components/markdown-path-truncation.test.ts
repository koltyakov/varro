import { afterEach, describe, expect, it } from 'vitest';
import { middleTruncatePathLabel, selectionText } from './markdown-path-truncation';

function createLink(label: string, rest = ''): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.className = 'file-path-link';
  const leadingContent = document.createElement('span');
  leadingContent.className = 'link-leading-content';
  const icon = document.createElement('img');
  icon.className = 'file-path-icon';
  const leadingLabel = document.createElement('span');
  leadingLabel.className = 'link-leading-label';
  leadingLabel.textContent = label;
  leadingContent.append(icon, leadingLabel);
  anchor.append(leadingContent, document.createTextNode(rest));
  document.body.append(anchor);
  return anchor;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('middleTruncatePathLabel', () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  });

  it('keeps the file name and line suffix together after the elided directory', () => {
    const anchor = createLink('/private/tmp/reports/tier1/report.md', ' (line 4)');

    middleTruncatePathLabel(anchor);

    const wrapper = anchor.firstElementChild;
    expect(wrapper?.className).toBe('path-middle-truncate');
    expect(anchor.childNodes).toHaveLength(1);
    expect(wrapper?.querySelector('.link-leading-content > .file-path-icon')).not.toBeNull();
    expect(wrapper?.querySelector('.link-leading-label')?.textContent).toBe(
      '/private/tmp/reports/tier1'
    );
    expect(wrapper?.querySelector('.link-trailing-label')?.textContent).toBe('/report.md (line 4)');
    expect(anchor.textContent).toBe('/private/tmp/reports/tier1/report.md (line 4)');
  });

  it('splits Windows paths and ignores trailing separators', () => {
    const windowsLink = createLink('C:\\repo\\src\\index.ts');
    const folderLink = createLink('src/components/');

    middleTruncatePathLabel(windowsLink);
    middleTruncatePathLabel(folderLink);

    expect(windowsLink.querySelector('.link-trailing-label')?.textContent).toBe('\\index.ts');
    expect(folderLink.querySelector('.link-leading-label')?.textContent).toBe('src');
    expect(folderLink.querySelector('.link-trailing-label')?.textContent).toBe('/components/');
  });

  it('leaves table paths and labels without a directory unchanged', () => {
    const tableLink = createLink('src/shared/protocol.ts');
    const cell = document.createElement('td');
    document.body.append(document.createElement('table'));
    document.body.querySelector('table')!.append(cell);
    cell.append(tableLink);
    const tableHtml = tableLink.innerHTML;
    middleTruncatePathLabel(tableLink);
    expect(tableLink.innerHTML).toBe(tableHtml);

    for (const label of ['README.md', '/README.md']) {
      const anchor = createLink(label);
      const html = anchor.innerHTML;

      middleTruncatePathLabel(anchor);

      expect(anchor.innerHTML).toBe(html);
    }
  });

  it('reads selection text with inline layout and reverts it synchronously', () => {
    const anchor = createLink('src/shared/protocol.ts');
    middleTruncatePathLabel(anchor);
    const root = document.documentElement;
    const selection = window.getSelection()!;
    selection.selectAllChildren(anchor);
    let copyingDuringRead = false;
    const read = selection.toString.bind(selection);
    selection.toString = () => {
      copyingDuringRead = root.classList.contains('is-copying-truncated-paths');
      return read();
    };

    try {
      expect(selectionText(selection)).toBe('src/shared/protocol.ts');
    } finally {
      Reflect.deleteProperty(selection, 'toString');
    }
    expect(copyingDuringRead).toBe(true);
    expect(root.classList).not.toContain('is-copying-truncated-paths');
  });

  it('restores inline layout only while a selected path is copied', async () => {
    const anchor = createLink('src/shared/protocol.ts');
    middleTruncatePathLabel(anchor);
    const root = document.documentElement;

    document.dispatchEvent(new Event('copy'));
    expect(root.classList).not.toContain('is-copying-truncated-paths');

    window.getSelection()?.selectAllChildren(anchor);
    document.dispatchEvent(new Event('copy'));
    expect(root.classList).toContain('is-copying-truncated-paths');

    await nextFrame();
    expect(root.classList).not.toContain('is-copying-truncated-paths');
  });
});
