import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { navArrowLeftIcon, navArrowRightIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
import type { AgentPart, FilePart, Part, TextPart } from '../../types';
import { resetDefaultAppState, setState as setAppState, state } from '../../lib/state';
import {
  UserMessageContent,
  UserMessagePreviewContent,
  formatUserMessageMarkupSize,
  getUserMessageMarkupSuffix,
  getUserMessagePreviewText,
  hasUserMessageEditableContent,
} from './UserMessageContent';
import { fixture } from '../../test-fixtures';
import type { UnknownRecord } from '../../../shared/type-utils';
import { clearDirectSessionReturn, getDirectSessionReturnId } from '../../lib/session-navigation';

const selectSessionMock = vi.hoisted(() => vi.fn());
const retryMessageMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise user-message actions through the useOpenCode module. */
vi.mock('../../hooks/useOpenCode', () => ({
  retryMessage: retryMessageMock,
  selectSession: selectSessionMock,
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

function textPart(id: string, text: string): TextPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
  };
}

function imageFilePart(id: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'image/png',
    filename,
    url: `https://example.test/${id}.png`,
  };
}

function pdfFilePart(id: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'application/pdf',
    filename,
    url: `https://example.test/${id}`,
  };
}

function agentPart(id: string, name: string, marker = `@${name}`): AgentPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'agent',
    name,
    source: { value: marker, start: 0, end: marker.length },
  };
}

function renderUserContent(parts: Part[]) {
  cleanup = render(() => UserMessageContent({ parts }), container!);
}

function installSendToExtension() {
  const send = vi.fn();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  fixture<UnknownRecord>(window).__sendToExtension = send;
  return send;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver implements globalThis.ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  resetDefaultAppState();
  clearDirectSessionReturn();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  document.body.classList.remove('chat-image-preview-open');
  selectSessionMock.mockReset();
  retryMessageMock.mockReset();
  setAppState('sessions', []);
  setAppState('allAgents', []);
  resetDefaultAppState();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete fixture<UnknownRecord>(window).__sendToExtension;
});

describe('UserMessageContent', () => {
  it('renders each text part as its own paragraph in the scroll container', () => {
    renderUserContent([textPart('text-1', 'Line 1'), textPart('text-2', 'Line 2')]);

    const scrollContainer = container?.querySelector('.user-message-text-scroll');
    expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
    expect(scrollContainer?.querySelectorAll('.user-message-text')).toHaveLength(2);
    expect(scrollContainer?.querySelectorAll('.user-message-text')[0]?.textContent?.trim()).toBe(
      'Line 1'
    );
    expect(scrollContainer?.querySelectorAll('.user-message-text')[1]?.textContent?.trim()).toBe(
      'Line 2'
    );
    expect(container?.querySelector('.message-attachments')).toBeNull();
    expect(container?.querySelector('.user-message-empty')).toBeNull();
  });

  it('shows the empty placeholder for prompts without renderable content', () => {
    renderUserContent([textPart('text-1', '[Working directory: /repo]'), textPart('text-2', '')]);

    expect(container?.querySelector('.user-message-empty')?.textContent).toBe('(no content)');
    expect(container?.querySelector('.user-message-text-scroll')).toBeNull();
    expect(container?.querySelector('.message-attachments')).toBeNull();
  });

  it('renders fenced code with its language and leaves fenced URLs unlinkified', () => {
    renderUserContent([textPart('text-1', '```text\nhttps://example.test/docs\n```')]);

    expect(container?.querySelector('.user-message-code-block .code-block-lang')?.textContent).toBe(
      'text'
    );
    expect(container?.querySelector('.user-message-code-block code')?.textContent).toBe(
      'https://example.test/docs\n'
    );
    expect(container?.querySelector('a.external-link')).toBeNull();
  });

  it('renders Markdown while preserving attachment chips outside code', () => {
    renderUserContent([
      textPart(
        'text-1',
        [
          '# Review',
          '',
          '- Use **@README.md** with *care*',
          '- Keep `@README.md` literal in code',
          '',
          '> Confirm the result',
        ].join('\n')
      ),
      textPart('text-2', 'README.md'),
    ]);

    const markdown = container?.querySelector('.user-message-markdown');
    expect(markdown?.querySelector('h1')?.textContent).toBe('Review');
    expect(markdown?.querySelectorAll('li')).toHaveLength(2);
    expect(markdown?.querySelector('strong .inline-chip')?.textContent).toBe('README.md');
    expect(markdown?.querySelector('em')?.textContent).toBe('care');
    expect(markdown?.querySelector('code')?.textContent).toBe('@README.md');
    expect(markdown?.querySelectorAll('.inline-chip')).toHaveLength(1);
    expect(markdown?.querySelector('blockquote')?.textContent?.trim()).toBe('Confirm the result');
  });

  it('renders Markdown links through the external-link bridge', () => {
    const send = installSendToExtension();
    renderUserContent([textPart('text-1', 'Read the [documentation](https://example.test/docs).')]);

    const link = container?.querySelector<HTMLAnchorElement>('a.external-link');
    expect(link?.textContent).toContain('documentation');
    expect(link?.getAttribute('href')).toBe('https://example.test/docs');

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://example.test/docs' },
    });
  });

  it('trims blank lines around prose between fenced code blocks', () => {
    renderUserContent([
      textPart(
        'text-1',
        ['```', 'something', '```', '', 'Another text', '', '```', 'something else', '```'].join(
          '\n'
        )
      ),
    ]);

    const scrollContainer = container?.querySelector('.user-message-text-scroll');
    expect(scrollContainer?.querySelectorAll('.interactive-result-code-block')).toHaveLength(2);
    expect(scrollContainer?.querySelector('.user-message-text')?.textContent).toBe('Another text');
  });

  it('compacts standalone SVG markup into a chip that opens in an editor', () => {
    const send = installSendToExtension();
    const svg = '<svg viewBox="0 0 10 10">\n  <path d="M0 0h10v10z" />\n</svg>';
    renderUserContent([textPart('text-svg', svg)]);

    const chip = container?.querySelector<HTMLButtonElement>('.user-message-format-chip');
    expect(chip?.textContent).toBe('SVG59 B');
    expect(chip?.getAttribute('data-copy-marker')).toBe(svg);
    expect(chip?.getAttribute('title')).toBe('Open SVG content - 59 B');
    expect(container?.querySelector('.user-message-text')?.textContent).not.toContain('<svg');

    chip?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        content: svg,
        title: 'SVG user message',
        language: 'xml',
      },
    });
  });

  it('keeps leading prose while compacting a trailing XML document into a chip', () => {
    const prompt = [
      'In input, change the agent chip icon to',
      '',
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg width="16px" height="16px" viewBox="0 0 24 24">',
      '  <rect x="2" y="21" width="7" height="5" />',
      '</svg>',
    ].join('\n');
    renderUserContent([textPart('text-prose-svg', prompt)]);

    const messageText = container?.querySelectorAll('.user-message-text');
    expect(messageText).toHaveLength(2);
    expect(messageText?.[0]?.textContent?.trim()).toBe('In input, change the agent chip icon to');
    expect(messageText?.[1]?.textContent).toBe('SVG143 B');
    expect(messageText?.[1]?.classList).toContain('user-message-format-chip-row');
    expect(
      container?.querySelector('.user-message-format-chip')?.getAttribute('data-copy-marker')
    ).toBe(prompt.slice(prompt.indexOf('<?xml')));
    expect(container?.textContent).not.toContain('<rect');
  });

  it('leaves malformed markup as plain message text', () => {
    const malformed = '<svg><path></svg>';
    renderUserContent([textPart('text-malformed-svg', malformed)]);

    expect(container?.querySelector('.user-message-format-chip')).toBeNull();
    expect(container?.querySelector('.user-message-text')?.textContent).toBe(malformed);
  });

  it('renders attachment-only prompts as a standalone attachment strip', () => {
    renderUserContent([textPart('text-1', '[Active file: src/shared/extension-message.ts]')]);

    const attachments = container?.querySelector('.message-attachments');
    expect(attachments).toBeInstanceOf(HTMLDivElement);
    expect(attachments?.classList.contains('message-attachments-standalone')).toBe(true);
    expect(attachments?.textContent).toContain('extension-message.ts');
    expect(container?.querySelector('.user-message-text-scroll')).toBeNull();
  });

  it('orders visible attachments above text, other file parts, and images', () => {
    renderUserContent([
      textPart('text-1', '[Active file: src/shared/extension-message.ts]'),
      pdfFilePart('file-1', 'spec.pdf'),
      textPart('text-2', 'Please review this.'),
      imageFilePart('image-1', 'diagram.png'),
    ]);

    const rendered = container?.querySelector('.rendered-markdown');
    expect(rendered?.classList.contains('user-message-content-has-image')).toBe(true);
    const children = Array.from(rendered?.children ?? []);
    expect(children[0]?.classList.contains('message-attachments')).toBe(true);
    expect(children[0]?.classList.contains('message-attachments-leading')).toBe(true);
    expect(children[0]?.textContent).toContain('extension-message.ts');
    expect(children[0]?.textContent).toContain('spec.pdf');
    expect(children[0]?.querySelectorAll('.message-attachment-chip')).toHaveLength(2);
    expect(children[0]?.querySelectorAll('.message-attachment-chip .file-type-icon')).toHaveLength(
      2
    );
    expect(children[1]?.classList.contains('user-message-text-scroll')).toBe(true);
    expect(children[1]?.textContent).toContain('Please review this.');
    expect(children[2]?.classList.contains('chat-image-figure')).toBe(true);
    expect(children[2]?.querySelector('img')?.getAttribute('alt')).toBe('diagram.png');
  });

  it('collapses excess attachments into a popup', () => {
    renderUserContent([
      textPart('text-1', 'one.ts'),
      textPart('text-2', 'two.ts'),
      textPart('text-3', 'three.ts'),
      textPart('text-4', 'four.ts'),
    ]);

    const trigger = container?.querySelector<HTMLButtonElement>(
      '.message-attachment-overflow-trigger'
    );
    expect(trigger?.textContent).toBe('+1');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('.message-attachment-overflow-menu')).toBeNull();
    const rail = container?.querySelector('.message-file-attachments');
    const railChildCount = rail?.childElementCount;

    trigger?.click();

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelector('.message-attachment-overflow-menu')).toBeNull();
    expect(rail?.childElementCount).toBe(railChildCount);
    const popup = document.body.querySelector('.message-attachment-overflow-menu');
    expect(popup?.getAttribute('aria-label')).toBe('Remaining attachments');
    expect(popup?.textContent).toContain('four.ts');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.querySelector('.message-attachment-overflow-menu')).toBeNull();
  });

  it('expands a standalone terminal selection into an editor-backed terminal preview', () => {
    const send = installSendToExtension();
    renderUserContent([
      textPart(
        'text-terminal-selection',
        '[Selection from terminal zsh]\n```text\nnpm test\nfailed output\n```'
      ),
    ]);

    const terminalBlock = container?.querySelector('.user-message-terminal-code-block');
    expect(terminalBlock).toBeInstanceOf(HTMLDivElement);
    expect(
      terminalBlock?.querySelector('.code-block-header .user-message-terminal-header-icon')
    ).toBeInstanceOf(HTMLImageElement);
    expect(terminalBlock?.querySelector('.code-block-lang')?.textContent).toBe('zsh');
    expect(terminalBlock?.querySelector('.code-block-detail')?.textContent).toBe('2 lines');
    expect(terminalBlock?.querySelector('code')?.textContent).toBe('npm test\nfailed output');
    expect(container?.querySelector('.message-attachment-chip')).toBeNull();
    expect(container?.querySelector('.user-message-text-scroll')).toBeNull();

    const preview = container?.querySelector<HTMLElement>('.user-message-terminal-preview');
    expect(preview?.getAttribute('role')).toBe('button');
    expect(preview?.getAttribute('tabindex')).toBe('0');
    const bubbledClick = vi.fn();
    container?.addEventListener('click', bubbledClick);

    terminalBlock?.querySelector<HTMLElement>('.code-block-header')?.click();
    expect(send).not.toHaveBeenCalled();
    expect(bubbledClick).toHaveBeenCalledTimes(1);

    terminalBlock?.querySelector<HTMLElement>('pre.code-block')?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        content: 'npm test\nfailed output',
        title: 'zsh terminal selection',
        language: 'shellscript',
      },
    });
  });

  it('expands a terminal selection below other attachments when there is no message or image', () => {
    renderUserContent([
      textPart('text-file', 'package.json'),
      textPart(
        'text-terminal-selection',
        '[Selection from terminal zsh]\n```text\nnpm test\nfailed output\n```'
      ),
    ]);

    const attachments = container?.querySelector('.message-attachments');
    expect(attachments?.classList).toContain('message-attachments-leading');
    expect(attachments?.querySelectorAll('.message-attachment-chip')).toHaveLength(1);
    expect(attachments?.textContent).toContain('package.json');
    expect(attachments?.textContent).not.toContain('zsh');
    expect(container?.querySelector('.user-message-terminal-code-block')).toBeInstanceOf(
      HTMLDivElement
    );
  });

  it('keeps a terminal compact when an image is attached', () => {
    renderUserContent([
      textPart(
        'text-terminal-selection',
        '[Selection from terminal zsh]\n```text\nnpm test\nfailed output\n```'
      ),
      imageFilePart('image-1', 'diagram.png'),
    ]);

    expect(container?.querySelector('.user-message-terminal-code-block')).toBeNull();
    expect(container?.querySelector('.message-attachment-chip')?.textContent).toContain('zsh');
    expect(container?.querySelector('.chat-image-figure')).toBeInstanceOf(HTMLElement);
  });

  it('opens a mixed terminal selection chip as shellscript text', () => {
    const send = installSendToExtension();
    renderUserContent([
      textPart(
        'text-1',
        'Why does this fail?\n[Selection from terminal zsh]\n```text\nnpm test\nfailed output\n```'
      ),
    ]);

    const strip = container?.querySelector('.message-attachments');
    expect(strip?.classList.contains('message-attachments-leading')).toBe(true);
    const chip = container?.querySelector<HTMLButtonElement>(
      '.message-attachment-chip.message-attachment-chip-clickable'
    );
    expect(chip).toBeInstanceOf(HTMLButtonElement);
    expect(chip?.getAttribute('title')).toBe('Terminal: zsh');
    expect(chip?.textContent).toContain('zsh');
    expect(chip?.querySelector('.chip-detail')?.textContent).toBe('2 lines');
    expect(container?.querySelector('.user-message-text')?.textContent?.trim()).toBe(
      'Why does this fail?'
    );

    chip?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        content: 'npm test\nfailed output',
        title: 'zsh terminal selection',
        language: 'shellscript',
      },
    });
  });

  it('renders a terminal selection without text as a non-clickable chip', () => {
    const send = installSendToExtension();
    renderUserContent([textPart('text-1', '[Selection from terminal zsh]')]);

    const chip = container?.querySelector('.message-attachment-chip');
    expect(chip).toBeInstanceOf(HTMLSpanElement);
    expect(chip?.classList.contains('message-attachment-chip-clickable')).toBe(false);
    expect(chip?.getAttribute('title')).toBe('Terminal: zsh');
    expect(chip?.textContent).toContain('terminal');
    expect(container?.querySelector('.user-message-terminal-code-block')).toBeNull();

    chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves attachment opens against the workspace with selection lines and directory kind', () => {
    const send = installSendToExtension();
    setAppState('editorContext', { ...state.editorContext, workspacePath: '/workspace' });
    renderUserContent([
      textPart('text-1', 'Review these\n[Selection from src/main.ts lines 2-4]'),
      textPart('text-2', 'assets/'),
    ]);

    const chips = container?.querySelectorAll<HTMLButtonElement>(
      '.message-attachment-chip-clickable'
    );
    expect(chips).toHaveLength(2);

    const selectionChip = Array.from(chips ?? []).find(
      (chip) => chip.getAttribute('title') === 'src/main.ts:2-4'
    );
    expect(selectionChip?.textContent).toContain('main.ts');
    expect(selectionChip?.querySelector('.file-type-icon')).toBeInstanceOf(HTMLImageElement);
    expect(selectionChip?.querySelector('.chip-detail')?.textContent).toBe('L2-4');
    selectionChip?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/workspace/src/main.ts', line: 2, kind: 'file' },
    });

    const folderChip = Array.from(chips ?? []).find(
      (chip) => chip.getAttribute('title') === 'assets/'
    );
    expect(folderChip?.textContent).toContain('assets');
    expect(folderChip?.querySelector('.file-type-icon')).toBeNull();
    folderChip?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/workspace/assets', line: undefined, kind: 'directory' },
    });
  });

  it('renders inline file mention chips inside the text and keeps unrelated attachments in the strip', () => {
    renderUserContent([
      textPart('text-1', 'Test @README.md'),
      textPart('text-2', 'README.md'),
      textPart('text-3', 'preview.html'),
    ]);

    const messageText = container?.querySelector('.user-message-text');
    expect(messageText?.textContent?.trim()).toBe('Test README.md');
    expect(messageText?.querySelectorAll('.inline-chip')).toHaveLength(1);
    expect(messageText?.querySelector('.inline-chip .file-type-icon')).toBeInstanceOf(
      HTMLImageElement
    );
    expect(messageText?.querySelector('.inline-chip')?.getAttribute('data-copy-marker')).toBe(
      '@README.md'
    );

    const strip = container?.querySelector('.message-attachments');
    expect(strip).toBeInstanceOf(HTMLDivElement);
    expect(strip?.textContent).toContain('preview.html');
    expect(strip?.textContent).not.toContain('README.md');
  });

  it('renders inline image placeholder chips and opens the matching preview', () => {
    renderUserContent([
      textPart('text-1', 'Compare [Image 1] with [Image 2]'),
      imageFilePart('image-1', 'Image 1'),
      imageFilePart('image-2', 'Image 2'),
    ]);

    const messageText = container?.querySelector('.user-message-text');
    expect(messageText?.textContent?.trim()).toBe('Compare Image 1 with Image 2');
    const imageChips = Array.from(
      messageText?.querySelectorAll<HTMLButtonElement>('.inline-chip-clickable') ?? []
    );
    expect(imageChips.map((chip) => chip.textContent?.trim())).toEqual(['Image 1', 'Image 2']);
    expect(imageChips.every((chip) => !chip.hasAttribute('title'))).toBe(true);

    imageChips[1]?.click();

    const overlayImage = document.body.querySelector<HTMLImageElement>('.chat-image-preview-img');
    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-2.png');
    expect(document.body.querySelector('.chat-image-preview-caption')?.textContent).toContain(
      'Image 2'
    );
    expect(container?.querySelector('.message-image-carousel-caption-row')?.textContent).toContain(
      '2 / 2'
    );
  });

  it('maps the legacy [Image] marker to the first image pill', () => {
    renderUserContent([textPart('text-1', 'Review [Image]'), imageFilePart('image-1', 'Image 1')]);

    const imageChip = container?.querySelector('.user-message-text .inline-chip');
    expect(imageChip?.textContent?.trim()).toBe('Image 1');
    expect(imageChip?.getAttribute('data-copy-marker')).toBe('[Image]');
  });

  it('renders a single image as a plain figure and closes its preview with Escape', () => {
    renderUserContent([imageFilePart('image-1', 'diagram.png')]);

    expect(container?.querySelector('.message-image-carousel')).toBeNull();
    const trigger = container?.querySelector<HTMLButtonElement>('.chat-image-preview-trigger');
    expect(trigger?.getAttribute('aria-label')).toBe('Open image preview: diagram.png');

    trigger?.click();

    expect(document.body.querySelector('.chat-image-preview-overlay')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(document.body.classList.contains('chat-image-preview-open')).toBe(true);
    expect(
      document.body.querySelector<HTMLImageElement>('.chat-image-preview-img')?.getAttribute('src')
    ).toBe('https://example.test/image-1.png');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.body.querySelector('.chat-image-preview-overlay')).toBeNull();
    expect(document.body.classList.contains('chat-image-preview-open')).toBe(false);
  });

  it('steps the image carousel with its navigation controls', () => {
    renderUserContent([imageFilePart('image-1', 'Image 1'), imageFilePart('image-2', 'Image 2')]);

    const carousel = container?.querySelector('.message-image-carousel');
    expect(carousel).toBeInstanceOf(HTMLDivElement);
    const caption = carousel?.querySelector('.message-image-carousel-caption-row');
    expect(caption?.textContent).toContain('1 / 2');
    expect(caption?.textContent).toContain('Image 1');
    expect(carousel?.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/image-1.png'
    );

    const navButtons = carousel?.querySelectorAll<HTMLButtonElement>('.message-image-carousel-nav');
    expect(
      [...(navButtons || [])].map((button) =>
        button.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
      )
    ).toEqual([toCssUrl(navArrowLeftIcon), toCssUrl(navArrowRightIcon)]);
    navButtons?.[1]?.click();

    expect(caption?.textContent).toContain('2 / 2');
    expect(caption?.textContent).toContain('Image 2');
    expect(caption?.textContent).toContain('image/png');
    expect(carousel?.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/image-2.png'
    );

    navButtons?.[0]?.click();

    expect(caption?.textContent).toContain('1 / 2');
  });

  it('links known session references and selects the session on click', () => {
    setAppState('activeSessionId', 'ses_origin123');
    setAppState('sessions', [
      {
        id: 'ses_found123',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Permission request states',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    renderUserContent([
      textPart('text-1', 'Session session:ses_found123 and session:ses_missing456'),
    ]);

    const link = container?.querySelector<HTMLAnchorElement>('a.session-reference-link');
    expect(link?.textContent).toBe('Permission request states');
    expect(link?.getAttribute('href')).toBe('#session/ses_found123');
    expect(link?.getAttribute('data-copy-marker')).toBe('session:ses_found123');
    expect(link?.getAttribute('data-session-id')).toBe('ses_found123');
    expect(link?.querySelector('.session-reference-icon')).not.toBeNull();
    expect(container?.textContent).toContain('session:ses_missing456');

    link?.click();
    expect(selectSessionMock).toHaveBeenCalledWith('ses_found123');
    expect(getDirectSessionReturnId('ses_found123')).toBe('ses_origin123');
  });

  it('renders HTTPS URLs as external links and opens them through the bridge', () => {
    const send = installSendToExtension();
    renderUserContent([
      textPart('text-1', 'See https://example.test/docs but not http://insecure.test/x.'),
    ]);

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.external-link');
    expect(links).toHaveLength(1);
    const link = links?.[0];
    expect(link?.getAttribute('href')).toBe('https://example.test/docs');
    expect(link?.getAttribute('data-external')).toBe('true');
    expect(link?.firstElementChild?.classList).toContain('link-leading-content');
    expect(container?.querySelector('.user-message-text')?.textContent).toContain(
      'See https://example.test/docs but not http://insecure.test/x.'
    );

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://example.test/docs' },
    });
  });

  it('keeps one-line prose ending in a URL as message text', () => {
    renderUserContent([textPart('text-1', 'Test message https://iconoir.com')]);

    expect(container?.querySelector('.message-attachments')).toBeNull();
    expect(container?.querySelector('.user-message-text')?.textContent?.trim()).toBe(
      'Test message https://iconoir.com'
    );
    expect(
      container?.querySelector<HTMLAnchorElement>('a.external-link')?.getAttribute('href')
    ).toBe('https://iconoir.com');
  });

  it('keeps prose ending in a Git remote as linked message text', () => {
    const send = installSendToExtension();
    const prompt =
      'All JS should be strongly typed similar as in git@github.com:koltyakov/browser-bridge.git';
    renderUserContent([textPart('text-1', prompt)]);

    expect(container?.querySelector('.message-attachments')).toBeNull();
    expect(container?.querySelector('.user-message-text')?.textContent?.trim()).toBe(prompt);
    const link = container?.querySelector<HTMLAnchorElement>('a.external-link');
    expect(link?.textContent).toBe('git@github.com:koltyakov/browser-bridge.git');
    expect(link?.querySelector('.material-chip-icon')).toBeInstanceOf(HTMLImageElement);

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://github.com/koltyakov/browser-bridge' },
    });
  });

  it('hides delegated vision routing context while keeping inline image and agent chips', () => {
    const image = imageFilePart('image-1', '1786723794731-image-1');
    image.source = {
      text: {
        value: '{file:/tmp/varro-drops/drop-1/1786723794731-image-1}',
        start: 102,
        end: 162,
      },
      type: 'file',
      path: '/tmp/varro-drops/drop-1/1786723794731-image-1',
    };

    renderUserContent([
      textPart('text-1', "What's on this image? [Image 1] @vision"),
      agentPart('agent-1', 'vision'),
      textPart(
        'text-2',
        '[Image for @vision: /tmp/varro-drops/drop-1/1786723794731-image-1]\n' +
          'When calling the vision subagent, include {file:/tmp/varro-drops/drop-1/1786723794731-image-1} in its task prompt.'
      ),
      image,
    ]);

    expect(container?.querySelector('.user-message-text')?.textContent?.trim()).toBe(
      "What's on this image? Image 1 Vision"
    );
    expect(container?.querySelectorAll('.user-message-text .inline-chip')).toHaveLength(2);
    expect(container?.querySelector('.user-message-text .material-chip-icon')).toBeInstanceOf(
      HTMLImageElement
    );
    expect(container?.textContent).not.toContain('When calling the vision subagent');
    expect(container?.querySelector('.chat-image-img')).toBeInstanceOf(HTMLImageElement);
  });

  it('renders agent parts as leading chips when not mentioned in the text', () => {
    renderUserContent([textPart('text-1', 'Run the review'), agentPart('agent-1', 'vision')]);

    const strip = container?.querySelector('.message-attachments');
    expect(strip?.classList.contains('message-attachments-leading')).toBe(true);
    const chip = strip?.querySelector('.message-attachment-chip');
    expect(chip?.textContent).toContain('Vision');
    expect(chip?.getAttribute('title')).toBe('Agent: Vision');
    expect(chip?.getAttribute('data-copy-marker')).toBe('@vision');
    expect(chip?.querySelector('.material-chip-icon')).toBeInstanceOf(HTMLImageElement);
    expect(container?.querySelector('.user-message-text')?.textContent?.trim()).toBe(
      'Run the review'
    );
  });

  it('renders textual agent mentions from known agents as inline chips', () => {
    setAppState('allAgents', [
      {
        name: 'vision',
        mode: 'subagent',
        permission: [],
      },
    ]);
    renderUserContent([textPart('text-1', "What's on the image? @vision")]);

    const chip = container?.querySelector('.user-message-text .inline-chip');
    expect(chip?.textContent).toBe('Vision');
    expect(chip?.getAttribute('data-copy-marker')).toBe('@vision');
    expect(container?.querySelector('.message-attachments')).toBeNull();
  });

  it('toggles the overflow fade as the prompt text scrolls', () => {
    renderUserContent([textPart('text-1', 'A long prompt')]);

    const scrollContainer = container?.querySelector<HTMLElement>('.user-message-text-scroll');
    expect(scrollContainer).not.toBeNull();
    Object.defineProperties(scrollContainer!, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 240 },
    });

    scrollContainer!.scrollTop = 0;
    scrollContainer!.dispatchEvent(new Event('scroll'));
    expect(scrollContainer?.classList.contains('has-more-below')).toBe(true);

    scrollContainer!.scrollTop = 140;
    scrollContainer!.dispatchEvent(new Event('scroll'));
    expect(scrollContainer?.classList.contains('has-more-below')).toBe(false);
  });

  it('copies selection text restoring inline attachment markers', () => {
    renderUserContent([
      textPart('text-1', 'Check @handlers.js and @README.md today'),
      textPart('text-2', 'handlers.js'),
      textPart('text-3', 'README.md'),
    ]);

    const messageCard = container?.querySelector<HTMLElement>('.rendered-markdown');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(messageCard!);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
    });

    messageCard?.dispatchEvent(event);

    expect(setData).toHaveBeenCalledWith('text/plain', 'Check @handlers.js and @README.md today');
  });
});

describe('UserMessagePreviewContent', () => {
  it('renders the first meaningful text with inline chips', () => {
    cleanup = render(
      () =>
        UserMessagePreviewContent({
          parts: [
            textPart('text-1', '[Working directory: /repo]'),
            textPart('text-2', 'Check @README.md'),
            textPart('text-3', 'README.md'),
          ],
          fallback: 'Fallback',
        }),
      container!
    );

    const messageText = container?.querySelector('.user-message-text');
    expect(messageText?.textContent?.trim()).toBe('Check README.md');
    expect(messageText?.querySelectorAll('.inline-chip')).toHaveLength(1);
    expect(messageText).toBeInstanceOf(HTMLParagraphElement);
    expect(container?.querySelector('.user-message-markdown')).toBeNull();
  });

  it('keeps Markdown source inline so sticky sizing stays compact', () => {
    cleanup = render(
      () =>
        UserMessagePreviewContent({
          parts: [textPart('text-1', '**Review** this prompt')],
          fallback: 'Fallback',
        }),
      container!
    );

    const messageText = container?.querySelector('.user-message-text');
    expect(messageText).toBeInstanceOf(HTMLParagraphElement);
    expect(messageText?.textContent).toBe('**Review** this prompt');
    expect(messageText?.querySelector('strong')).toBeNull();
  });

  it('falls back to the provided label when no message text exists', () => {
    cleanup = render(
      () =>
        UserMessagePreviewContent({
          parts: [imageFilePart('image-1', 'shot.png')],
          fallback: 'Attachments only',
        }),
      container!
    );

    expect(container?.textContent).toBe('Attachments only');
    expect(container?.querySelector('.user-message-text')).toBeNull();
  });
});

describe('getUserMessageMarkupSuffix', () => {
  it('splits prefix prose from a trailing markup document', () => {
    const prompt = [
      'In input, change the agent chip icon to',
      '',
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg width="16px" height="16px" viewBox="0 0 24 24">',
      '  <rect x="2" y="21" width="7" height="5" />',
      '</svg>',
    ].join('\n');

    const suffix = getUserMessageMarkupSuffix(prompt);
    expect(suffix?.prefix).toBe('In input, change the agent chip icon to');
    expect(suffix?.content.startsWith('<?xml')).toBe(true);
    expect(suffix?.format).toEqual({ kind: 'svg', byteSize: 143 });
  });

  it('returns null for plain prose', () => {
    expect(getUserMessageMarkupSuffix('Just prose with no markup')).toBeNull();
  });
});

describe('formatUserMessageMarkupSize', () => {
  it.each([
    [500, '500 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [20480, '20 KB'],
  ])('formats %d bytes as %s', (byteSize, expected) => {
    expect(formatUserMessageMarkupSize(byteSize)).toBe(expected);
  });
});

describe('hasUserMessageEditableContent', () => {
  it('requires prompt text or re-addable context', () => {
    expect(hasUserMessageEditableContent([textPart('text-1', 'fix the test')])).toBe(true);
    expect(hasUserMessageEditableContent([textPart('text-1', '[Working directory: /repo]')])).toBe(
      false
    );
    expect(hasUserMessageEditableContent([])).toBe(false);
    expect(hasUserMessageEditableContent([imageFilePart('image-1', 'shot.png')])).toBe(true);
    expect(
      hasUserMessageEditableContent([
        textPart('text-1', '[Selection from terminal zsh]\n```text\nnpm test\n```'),
      ])
    ).toBe(true);
  });
});

describe('getUserMessagePreviewText', () => {
  it('falls back to folder, agent, and empty-content labels', () => {
    expect(getUserMessagePreviewText([textPart('text-1', 'assets/')])).toBe('Folder: assets');
    expect(getUserMessagePreviewText([agentPart('agent-1', 'vision')])).toBe('Agent: Vision');
    expect(getUserMessagePreviewText([])).toBe('(no content)');
  });
});
