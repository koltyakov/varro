import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeClipboard } from './write-clipboard';

describe('writeClipboard', () => {
  let originalClipboard: Clipboard;
  let originalExecCommand: typeof document.execCommand;

  beforeEach(() => {
    originalClipboard = navigator.clipboard;
    originalExecCommand = document.execCommand;
    document.execCommand = vi.fn(() => false);
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    document.execCommand = originalExecCommand;
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
    (document.execCommand as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await writeClipboard('fallback text');
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(result).toBe(true);
  });

  it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    (document.execCommand as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const result = await writeClipboard('no clipboard');
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(result).toBe(true);
  });

  it('returns false when both methods fail', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });

    const result = await writeClipboard('nothing works');
    expect(result).toBe(false);
  });
});
