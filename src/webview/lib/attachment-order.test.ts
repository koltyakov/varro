import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureClipboardImageAttachmentSequence,
  ensureContextFileAttachmentSequence,
  ensureNativePdfAttachmentSequence,
  getClipboardImageAttachmentSequence,
  getContextFileAttachmentSequence,
  getNativePdfAttachmentSequence,
  removeClipboardImageAttachmentSequence,
  removeContextFileAttachmentSequence,
  resetAttachmentOrderState,
  seedClipboardImageAttachmentSequences,
  seedContextFileAttachmentSequences,
} from './attachment-order';

describe('attachment order state', () => {
  beforeEach(() => {
    resetAttachmentOrderState();
  });

  it('reuses an existing sequence for the same context file', () => {
    expect(ensureContextFileAttachmentSequence('/repo/src/a.ts')).toBe(1);
    expect(ensureContextFileAttachmentSequence('/repo/src/a.ts', 99)).toBe(1);
    expect(getContextFileAttachmentSequence('/repo/src/a.ts')).toBe(1);
    expect(ensureContextFileAttachmentSequence('/repo/src/b.ts')).toBe(2);
  });

  it('reuses and removes sequences through equivalent Windows paths', () => {
    expect(ensureContextFileAttachmentSequence('C:\\Repo\\File.ts')).toBe(1);
    expect(ensureContextFileAttachmentSequence('c:/repo/file.ts', 99)).toBe(1);
    expect(getContextFileAttachmentSequence('C:/REPO/FILE.ts')).toBe(1);

    removeContextFileAttachmentSequence('c:\\repo\\file.ts');
    expect(getContextFileAttachmentSequence('C:/Repo/File.ts')).toBeUndefined();
  });

  it('advances generated sequences past seeded explicit values', () => {
    seedContextFileAttachmentSequences([
      {
        path: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        type: 'file',
        attachmentSequence: 7,
      },
    ]);
    seedClipboardImageAttachmentSequences([
      {
        id: 'image-a',
        url: 'data:image/png;base64,a',
        mime: 'image/png',
        filename: 'Image',
        size: 1,
        attachmentSequence: 9,
      },
    ]);
    ensureNativePdfAttachmentSequence('pdf-a', 10);

    expect(ensureContextFileAttachmentSequence('/repo/src/b.ts')).toBe(11);
    expect(ensureClipboardImageAttachmentSequence('image-b')).toBe(12);
  });

  it('removes individual context file and clipboard image sequences without rewinding order', () => {
    expect(ensureContextFileAttachmentSequence('/repo/src/a.ts')).toBe(1);
    expect(ensureClipboardImageAttachmentSequence('image-a')).toBe(2);

    removeContextFileAttachmentSequence('/repo/src/a.ts');
    removeClipboardImageAttachmentSequence('image-a');

    expect(getContextFileAttachmentSequence('/repo/src/a.ts')).toBeUndefined();
    expect(getClipboardImageAttachmentSequence('image-a')).toBeUndefined();
    expect(ensureContextFileAttachmentSequence('/repo/src/a.ts')).toBe(3);
  });

  it('resets maps and the next generated sequence', () => {
    ensureContextFileAttachmentSequence('/repo/src/a.ts');
    ensureClipboardImageAttachmentSequence('image-a');
    ensureNativePdfAttachmentSequence('pdf-a');

    resetAttachmentOrderState();

    expect(getContextFileAttachmentSequence('/repo/src/a.ts')).toBeUndefined();
    expect(getClipboardImageAttachmentSequence('image-a')).toBeUndefined();
    expect(getNativePdfAttachmentSequence('pdf-a')).toBeUndefined();
    expect(ensureClipboardImageAttachmentSequence('image-b')).toBe(1);
  });
});
