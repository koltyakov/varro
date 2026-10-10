import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeClipboard, writeClipboardImage } from './write-clipboard';
import { fixture } from '../test-fixtures';

type LegacyClipboardDocument = {
  execCommand(commandId: string): boolean;
};

describe('writeClipboard', () => {
  let originalClipboard: Clipboard;
  let legacyDocument: LegacyClipboardDocument;
  let originalExecCommand: LegacyClipboardDocument['execCommand'];
  let execCommandMock = vi.fn((_commandId: string): boolean => false);

  beforeEach(() => {
    originalClipboard = navigator.clipboard;
    // SAFETY: Tests replace the legacy clipboard method on jsdom's document fixture.
    legacyDocument = document as LegacyClipboardDocument;
    originalExecCommand = legacyDocument.execCommand;
    execCommandMock = vi.fn((_commandId: string): boolean => false);
    legacyDocument.execCommand = execCommandMock;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    legacyDocument.execCommand = originalExecCommand;
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const result = await writeClipboard('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(result).toBe(true);
  });

  it('falls back to execCommand when navigator.clipboard fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    execCommandMock.mockReturnValue(true);

    const result = await writeClipboard('fallback text');
    expect(execCommandMock).toHaveBeenCalledWith('copy');
    expect(result).toBe(true);
  });

  it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    execCommandMock.mockReturnValue(true);

    const result = await writeClipboard('no clipboard');
    expect(execCommandMock).toHaveBeenCalledWith('copy');
    expect(result).toBe(true);
  });

  it('keeps the fallback input inside an active modal', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    modal.appendChild(button);
    document.body.appendChild(modal);
    button.focus();
    execCommandMock.mockImplementation(() => {
      expect(modal.querySelector('textarea')?.parentElement).toBe(modal);
      return true;
    });

    const result = await writeClipboard('modal fallback');

    expect(result).toBe(true);
    expect(modal.querySelector('textarea')).toBeNull();
    modal.remove();
  });

  it('returns false when both methods fail', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });

    const result = await writeClipboard('nothing works');
    expect(result).toBe(false);
  });

  it('returns false when browser globals are unavailable', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);

    try {
      await expect(writeClipboard('no browser')).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('writeClipboardImage', () => {
  const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>();
  const drawImage = vi.fn();
  let image: HTMLImageElement;
  let data: Record<string, Blob | Promise<Blob>>;
  let encode: BlobCallback;
  const canvas = () => {
    const element = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.contexts[0];
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Expected an image canvas');
    return element;
  };
  let originalClipboard: Clipboard;

  beforeEach(() => {
    originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      value: { write },
      configurable: true,
    });
    write.mockReset().mockResolvedValue();
    drawImage.mockClear();
    vi.stubGlobal(
      'ClipboardItem',
      class {
        readonly types = ['image/png'];
        constructor(value: Record<string, Blob | Promise<Blob>>) {
          data = value;
        }
      }
    );
    image = document.createElement('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 1920, configurable: true },
      naturalHeight: { value: 1080, configurable: true },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fixture<CanvasRenderingContext2D>({ drawImage })
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      encode = callback;
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts the clipboard write before encoding and copies full-size PNG pixels', async () => {
    const copying = writeClipboardImage(image);
    expect(write).toHaveBeenCalledOnce();
    expect(canvas().width).toBe(1920);
    expect(canvas().height).toBe(1080);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/png'
    );
    const blob = new Blob(['pixels'], { type: 'image/png' });
    encode(blob);
    await copying;
    await expect(data['image/png']).resolves.toBe(blob);
    expect(canvas().width).toBe(0);
    expect(canvas().height).toBe(0);
  });

  it('reports clipboard refusal and releases the canvas', async () => {
    write.mockRejectedValue(new Error('Clipboard permission denied'));
    const copying = writeClipboardImage(image);
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await expect(copying).rejects.toThrow('Clipboard permission denied');
    expect(canvas().width).toBe(0);
  });

  it('reports failed PNG encoding', async () => {
    const copying = writeClipboardImage(image);
    encode(null);
    await expect(copying).rejects.toThrow('Could not copy the image');
    expect(canvas().width).toBe(0);
  });

  it('does not copy an image that has not decoded', async () => {
    Object.defineProperty(image, 'naturalWidth', { value: 0 });
    await expect(writeClipboardImage(image)).rejects.toThrow('finish loading');
    expect(write).not.toHaveBeenCalled();
  });

  it('reports an unavailable image clipboard', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    await expect(writeClipboardImage(image)).rejects.toThrow('unavailable');
    expect(write).not.toHaveBeenCalled();
  });
});
