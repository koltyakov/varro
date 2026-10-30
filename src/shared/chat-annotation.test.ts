import { describe, expect, it } from 'vitest';
import {
  createChatAnnotation,
  getChatAnnotationLabel,
  isChatAnnotation,
  readChatAnnotation,
  readChatAnnotationFilePart,
} from './chat-annotation';
import { createPastedText, pastedTextDataUrl, readPastedTextDataUrl } from './pasted-text';

describe('chat annotations', () => {
  it('keeps the selected passage and note together as a sendable text attachment', () => {
    const file = createChatAnnotation(
      'First line\n雪 and café',
      'I disagree.\nPlease check again.'
    );
    expect(file.pastedText).toBe(
      'Chat annotation\n\nSelected text:\n> First line\n> 雪 and café\n\nComment:\nI disagree.\nPlease check again.'
    );
    expect(isChatAnnotation(file)).toBe(true);
    expect(readPastedTextDataUrl(pastedTextDataUrl(file.pastedText!))).toBe(file.pastedText);
    expect(createChatAnnotation('First line', 'Another note').relativePath).not.toBe(
      file.relativePath
    );
  });

  it('recognizes annotations restored from sent text attachments without mislabeling ordinary pastes', () => {
    const file = createChatAnnotation('A passage', 'A note');
    const restored = { ...createPastedText(file.pastedText!), relativePath: file.relativePath };
    expect(isChatAnnotation(restored)).toBe(true);
    expect(isChatAnnotation(createPastedText(file.pastedText!))).toBe(false);
    expect(isChatAnnotation({ relativePath: file.relativePath, pastedText: 'ordinary file' })).toBe(
      false
    );
  });

  it('rejects empty notes and oversized annotations without truncation', () => {
    expect(() => createChatAnnotation('text', '  ')).toThrow('enter an annotation');
    expect(() => createChatAnnotation('', 'note')).toThrow('Select chat text');
    expect(() => createChatAnnotation('雪'.repeat(22000), 'note')).toThrow('64 KB');
  });

  it('reads multiline comments and selected text without confusing quoted headings with metadata', () => {
    const selectedText = 'First passage\n\nComment:\nThis is still selected text';
    const note = 'Please check this.\n\nComment:\nAnd keep this part of my note.';
    const file = createChatAnnotation(selectedText, note);
    expect(readChatAnnotation(file)).toEqual({ selectedText, note });
    expect(readChatAnnotation(createPastedText('An ordinary paste'))).toBeNull();
    expect(
      readChatAnnotation({
        ...file,
        pastedText: 'Chat annotation\n\nSelected text:\n> Missing comment',
      })
    ).toBeNull();
  });

  it('preserves the source session when an annotation is copied into a different draft', () => {
    const file = createChatAnnotation('Original passage', 'Check this', 'session-source');
    const restored = { ...createPastedText(file.pastedText!), relativePath: file.relativePath };
    expect(file.pastedText).toContain('Source session: session-source');
    expect(readChatAnnotation(restored)).toEqual({
      selectedText: 'Original passage',
      note: 'Check this',
      sourceSessionId: 'session-source',
    });
    expect(() => createChatAnnotation('Text', 'Note', 'source\nSelected text: injected')).toThrow(
      'session ID'
    );
  });

  it('reads the same annotation from inline and deferred server file parts', () => {
    const file = createChatAnnotation('Original passage', 'Check this', 'session-source');
    const annotation = readChatAnnotation(file)!;
    const part = {
      mime: 'text/plain',
      filename: file.relativePath,
      url: pastedTextDataUrl(file.pastedText!),
    };
    expect(readChatAnnotationFilePart(part)).toEqual(annotation);
    expect(
      readChatAnnotationFilePart({ ...part, url: 'varro-content:/part/annotation', annotation })
    ).toEqual(annotation);
    expect(readChatAnnotationFilePart({ ...part, filename: 'notes.txt' })).toBeNull();
  });

  it('uses a bounded comment preview for chip labels without splitting Unicode characters', () => {
    expect(getChatAnnotationLabel('  Please\ncheck\tthis.  ')).toBe('Please check this.');
    expect(getChatAnnotationLabel('雪'.repeat(60))).toBe(`${'雪'.repeat(47)}…`);
    expect(getChatAnnotationLabel('😀'.repeat(60))).toBe(`${'😀'.repeat(47)}…`);
  });
});
