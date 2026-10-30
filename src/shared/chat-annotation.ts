import {
  createPastedText,
  MAX_PASTED_TEXT_BYTES,
  pastedTextBytes,
  readPastedTextDataUrl,
} from './pasted-text';
import type { DroppedFile } from './protocol';
import type { FilePart } from './opencode-types';

const ANNOTATION_HEADER = 'Chat annotation\n\n';
const SELECTED_TEXT_HEADER = 'Selected text:\n';
const COMMENT_SEPARATOR = '\n\nComment:\n';

export type ChatAnnotation = {
  selectedText: string;
  note: string;
  sourceSessionId?: string;
};

// Annotations are text attachments so drafts, queueing, and sends use the same lifecycle.
export function createChatAnnotation(
  selectedText: string,
  note: string,
  sourceSessionId?: string
): DroppedFile {
  if (!selectedText.trim() || !note.trim()) {
    throw new Error('Select chat text and enter an annotation before saving.');
  }
  if (
    sourceSessionId !== undefined &&
    (!sourceSessionId.trim() || sourceSessionId.length > 256 || /[\r\n]/.test(sourceSessionId))
  ) {
    throw new Error(
      'The annotation source session ID must be a nonempty single line of at most 256 characters.'
    );
  }
  const quotedText = selectedText.trim().replace(/^/gm, '> ');
  const source = sourceSessionId ? `Source session: ${sourceSessionId}\n\n` : '';
  const text = `${ANNOTATION_HEADER}${source}${SELECTED_TEXT_HEADER}${quotedText}${COMMENT_SEPARATOR}${note.trim()}`;
  if (pastedTextBytes(text) > MAX_PASTED_TEXT_BYTES) {
    throw new Error('Annotations are limited to 64 KB. Select less text or shorten your note.');
  }
  const file = createPastedText(text);
  return { ...file, relativePath: file.relativePath.replace('pasted-text-', 'annotation-') };
}

export function isChatAnnotation(file: Pick<DroppedFile, 'relativePath' | 'pastedText'>): boolean {
  return (
    isChatAnnotationFilename(file.relativePath) &&
    file.pastedText?.startsWith(ANNOTATION_HEADER) === true
  );
}

export function isChatAnnotationFilename(filename: string): boolean {
  return /^annotation-[a-f0-9]{8}\.txt$/.test(filename);
}

export function readChatAnnotation(
  file: Pick<DroppedFile, 'relativePath' | 'pastedText'>
): ChatAnnotation | null {
  if (!isChatAnnotation(file) || file.pastedText === undefined) return null;
  const source = file.pastedText
    .slice(ANNOTATION_HEADER.length)
    .match(/^Source session: ([^\r\n]+)\n\n/);
  if (source && (!source[1]!.trim() || source[1]!.length > 256)) return null;
  const selectedHeaderStart = ANNOTATION_HEADER.length + (source?.[0].length ?? 0);
  if (!file.pastedText.startsWith(SELECTED_TEXT_HEADER, selectedHeaderStart)) return null;
  const selectedStart = selectedHeaderStart + SELECTED_TEXT_HEADER.length;
  const separator = file.pastedText.indexOf(COMMENT_SEPARATOR, selectedStart);
  if (separator < 0) return null;
  const selectedText = file.pastedText.slice(selectedStart, separator).replace(/^> /gm, '');
  const note = file.pastedText.slice(separator + COMMENT_SEPARATOR.length);
  if (!selectedText.trim() || !note.trim()) return null;
  const annotation: ChatAnnotation = { selectedText, note };
  if (source) annotation.sourceSessionId = source[1];
  return annotation;
}

export function readChatAnnotationFilePart(
  part: Pick<FilePart, 'mime' | 'filename' | 'url' | 'annotation'>
): ChatAnnotation | null {
  if (part.mime !== 'text/plain' || !part.filename || !isChatAnnotationFilename(part.filename))
    return null;
  return (
    part.annotation ??
    readChatAnnotation({
      relativePath: part.filename,
      pastedText: readPastedTextDataUrl(part.url) ?? undefined,
    })
  );
}

export function getChatAnnotationLabel(note: string): string {
  const characters = Array.from(note.replace(/\s+/g, ' ').trim());
  return characters.length > 48 ? `${characters.slice(0, 47).join('')}…` : characters.join('');
}
