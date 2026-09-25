import type { DroppedFile } from './protocol';

export const MAX_PASTED_TEXT_BYTES = 64 * 1024;
export const MAX_PASTED_TEXT_TOTAL_BYTES = 256 * 1024;
const DATA_PREFIX = 'data:text/plain;charset=utf-8,';

export function isLargeTextPaste(text: string): boolean {
  return text.length >= 2000 || text.split(/\r\n|\r|\n/).length >= 25;
}

export function pastedTextBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function createPastedText(text: string): DroppedFile {
  if (pastedTextBytes(text) > MAX_PASTED_TEXT_BYTES) {
    throw new Error(
      'Text attachments are limited to 64 KB. Keep this paste inline or attach a file.'
    );
  }
  const id = crypto.randomUUID();
  return {
    path: `varro-paste:${id}`,
    relativePath: `pasted-text-${id.slice(0, 8)}.txt`,
    type: 'file',
    pastedText: text,
  };
}

export function pastedTextDataUrl(text: string): string {
  return `${DATA_PREFIX}${encodeURIComponent(text)}`;
}

export function readPastedTextDataUrl(url: string): string | null {
  const base64Prefix = 'data:text/plain;base64,';
  if (!url.startsWith(DATA_PREFIX) && !url.startsWith(base64Prefix)) return null;
  try {
    const text = url.startsWith(base64Prefix)
      ? new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(atob(url.slice(base64Prefix.length)), (character) =>
            character.charCodeAt(0)
          )
        )
      : decodeURIComponent(url.slice(DATA_PREFIX.length));
    return pastedTextBytes(text) <= MAX_PASTED_TEXT_BYTES ? text : null;
  } catch {
    return null;
  }
}
