import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeClipboard } from './write-clipboard';

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
