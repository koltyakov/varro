import { describe, expect, it } from 'vitest';
import { highlightCode, loadCodeHighlighter } from './code-highlighter';

describe('code highlighter loading', () => {
  it('retries after a transient module load failure', async () => {
    await expect(
      loadCodeHighlighter(() => Promise.reject(new Error('chunk unavailable')))
    ).rejects.toThrow('chunk unavailable');

    await expect(
      loadCodeHighlighter(() =>
        Promise.resolve({
          hasLanguage: () => true,
          highlightCode: (text: string) => `<strong>${text}</strong>`,
        })
      )
    ).resolves.toBeUndefined();
    expect(highlightCode('const value = 1;', 'typescript')).toBe(
      '<strong>const value = 1;</strong>'
    );
  });
});
