import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { DroppedFile } from '../../../shared/protocol';
import type { ClipboardImage } from '../../lib/app-state-types';
import { AttachmentStrip } from './AttachmentStrip';

type MockAttachmentChipProps = {
  label: string;
  detail?: string | null;
  disabled?: boolean;
  icon?: 'file' | 'folder' | 'image' | 'terminal';
  onClick?: () => void;
  onRemove?: () => void;
  title?: string;
};

vi.mock('./AttachmentChip', () => ({
  AttachmentChip: (props: MockAttachmentChipProps) => (
    <div
      class="attachment-chip-mock"
      data-clickable={props.onClick ? 'true' : 'false'}
      data-detail={props.detail ?? ''}
      data-disabled={props.disabled ? 'true' : 'false'}
      data-icon={props.icon ?? 'file'}
      data-label={props.label}
      data-title={props.title ?? ''}
    >
      <button class="attachment-chip-mock-click" onClick={() => props.onClick?.()}>
        click
      </button>
      <button class="attachment-chip-mock-remove" onClick={() => props.onRemove?.()}>
        remove
      </button>
    </div>
  ),
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

type AttachmentStripProps = Parameters<typeof AttachmentStrip>[0];

function createClipboardImage(overrides: Partial<ClipboardImage> = {}): ClipboardImage {
  return {
    id: 'image-1',
    url: 'blob:image-1',
    mime: 'image/png',
    filename: 'diagram.png',
    size: 1024,
    ...overrides,
  };
}

function createDroppedFile(overrides: Partial<DroppedFile> = {}): DroppedFile {
  return {
    path: '/workspace/src/example.ts',
    relativePath: 'src/example.ts',
    type: 'file',
    ...overrides,
  };
}

function renderAttachmentStrip(props: Partial<AttachmentStripProps> = {}) {
  const merged: AttachmentStripProps = {
    activeContext: null,
    activeContextEnabled: true,
    activeContextTitle: null,
    terminalSelection: null,
    files: [],
    clipboardImages: [],
    clipboardImagesDisabled: false,
    onToggleActiveContext: vi.fn(),
    onClearTerminalSelection: vi.fn(),
    onRemoveFile: vi.fn(),
    onRemoveClipboardImage: vi.fn(),
    ...props,
  };

  cleanup = render(() => AttachmentStrip(merged), container!);
  return merged;
}

function getChips() {
  return Array.from(container?.querySelectorAll('.attachment-chip-mock') ?? []);
}

function getChip(label: string) {
  return getChips().find((chip) => chip.getAttribute('data-label') === label) ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

describe('AttachmentStrip', () => {
  it('renders no chips when every attachment source is empty', () => {
    renderAttachmentStrip();

    expect(container?.querySelector('.chat-attachments-container')).toBeInstanceOf(HTMLDivElement);
    expect(getChips()).toHaveLength(0);
  });

  it('renders active-context and terminal chips with the expected titles and actions', () => {
    const firstRender = renderAttachmentStrip({
      activeContext: { filename: 'src/active.ts', lineRange: 'L4-8' },
      activeContextEnabled: false,
      activeContextTitle: null,
      terminalSelection: { terminalName: 'zsh' },
    });

    const activeContextChip = getChip('src/active.ts');
    const terminalChip = getChip('zsh');

    expect(activeContextChip?.getAttribute('data-detail')).toBe('L4-8');
    expect(activeContextChip?.getAttribute('data-disabled')).toBe('true');
    expect(activeContextChip?.getAttribute('data-title')).toBe('src/active.ts');
    expect(activeContextChip?.getAttribute('data-clickable')).toBe('true');
    expect(terminalChip?.getAttribute('data-detail')).toBe('terminal');
    expect(terminalChip?.getAttribute('data-icon')).toBe('terminal');
    expect(terminalChip?.getAttribute('data-title')).toBe('Terminal: zsh');

    activeContextChip
      ?.querySelector('.attachment-chip-mock-click')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    terminalChip
      ?.querySelector('.attachment-chip-mock-remove')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(firstRender.onToggleActiveContext).toHaveBeenCalledOnce();
    expect(firstRender.onClearTerminalSelection).toHaveBeenCalledOnce();

    cleanup?.();
    cleanup = undefined;

    renderAttachmentStrip({
      activeContext: { filename: 'src/active.ts', lineRange: null },
      activeContextEnabled: true,
      activeContextTitle: 'Selection from src/active.ts',
    });

    const titledActiveContextChip = getChip('src/active.ts');

    expect(titledActiveContextChip?.getAttribute('data-disabled')).toBe('false');
    expect(titledActiveContextChip?.getAttribute('data-title')).toBe(
      'Selection from src/active.ts'
    );
    expect(titledActiveContextChip?.getAttribute('data-detail')).toBe('');
  });

  it('formats dropped-file chips for ranged files and directories', () => {
    const renderResult = renderAttachmentStrip({
      files: [
        createDroppedFile({
          path: '/workspace/src/app.ts',
          relativePath: 'src/app.ts',
          lineRanges: [
            { startLine: 9, endLine: 12 },
            { startLine: 5, endLine: 5 },
          ],
        }),
        createDroppedFile({
          path: '/workspace/docs',
          relativePath: '',
          type: 'directory',
        }),
      ],
    });

    const fileChip = getChip('app.ts');
    const directoryChip = getChip('docs');

    expect(fileChip?.getAttribute('data-detail')).toBe('L5, L9-12');
    expect(fileChip?.getAttribute('data-icon')).toBe('file');
    expect(fileChip?.getAttribute('data-title')).toBe('src/app.ts L5, L9-12');
    expect(directoryChip?.getAttribute('data-detail')).toBe('');
    expect(directoryChip?.getAttribute('data-icon')).toBe('folder');
    expect(directoryChip?.getAttribute('data-title')).toBe('/workspace/docs');

    fileChip
      ?.querySelector('.attachment-chip-mock-remove')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    directoryChip
      ?.querySelector('.attachment-chip-mock-remove')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(renderResult.onRemoveFile).toHaveBeenNthCalledWith(1, '/workspace/src/app.ts');
    expect(renderResult.onRemoveFile).toHaveBeenNthCalledWith(2, '/workspace/docs');
  });

  it('marks clipboard images disabled only when the current model cannot send them', () => {
    const firstRender = renderAttachmentStrip({
      clipboardImages: [createClipboardImage()],
      clipboardImagesDisabled: true,
    });

    const disabledImageChip = getChip('diagram.png');
    expect(disabledImageChip?.getAttribute('data-disabled')).toBe('true');
    expect(disabledImageChip?.getAttribute('data-icon')).toBe('image');
    expect(disabledImageChip?.getAttribute('data-title')).toBe(
      "diagram.png · Current model doesn't support vision, so this image will not be sent"
    );

    disabledImageChip
      ?.querySelector('.attachment-chip-mock-remove')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(firstRender.onRemoveClipboardImage).toHaveBeenCalledWith('image-1');

    cleanup?.();
    cleanup = undefined;

    renderAttachmentStrip({
      clipboardImages: [createClipboardImage()],
      clipboardImagesDisabled: false,
    });

    const enabledImageChip = getChip('diagram.png');
    expect(enabledImageChip?.getAttribute('data-disabled')).toBe('false');
    expect(enabledImageChip?.getAttribute('data-title')).toBe('diagram.png');
  });

  it('opens files and previews images when their chips are clicked', () => {
    const renderResult = renderAttachmentStrip({
      files: [createDroppedFile()],
      clipboardImages: [createClipboardImage()],
      onOpenFile: vi.fn(),
      onPreviewImage: vi.fn(),
    });

    const fileChip = getChip('example.ts');
    const imageChip = getChip('diagram.png');

    expect(fileChip?.getAttribute('data-clickable')).toBe('true');
    expect(imageChip?.getAttribute('data-clickable')).toBe('true');

    fileChip
      ?.querySelector('.attachment-chip-mock-click')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    imageChip
      ?.querySelector('.attachment-chip-mock-click')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(renderResult.onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/src/example.ts' })
    );
    expect(renderResult.onPreviewImage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'image-1' })
    );
  });

  it('keeps file and image chips non-clickable without open/preview handlers', () => {
    renderAttachmentStrip({
      files: [createDroppedFile()],
      clipboardImages: [createClipboardImage()],
    });

    expect(getChip('example.ts')?.getAttribute('data-clickable')).toBe('false');
    expect(getChip('diagram.png')?.getAttribute('data-clickable')).toBe('false');
  });

  it('renders files and images in attachment sequence order', () => {
    renderAttachmentStrip({
      files: [
        createDroppedFile({
          path: '/workspace/src',
          relativePath: 'src',
          type: 'directory',
          attachmentSequence: 2,
        }),
      ],
      clipboardImages: [createClipboardImage({ attachmentSequence: 1 })],
    });

    expect(getChips().map((chip) => chip.getAttribute('data-label'))).toEqual([
      'diagram.png',
      'src',
    ]);
  });
});
