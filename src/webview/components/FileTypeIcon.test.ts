import { describe, expect, it } from 'vitest';
import { getFileTypeIcon } from './FileTypeIcon';

describe('getFileTypeIcon', () => {
  it('distinguishes common source formats', () => {
    expect(getFileTypeIcon('src/App.tsx')).not.toBe(getFileTypeIcon('src/app.ts'));
    expect(getFileTypeIcon('src/app.ts')).not.toBe(getFileTypeIcon('src/app.css'));
  });

  it('distinguishes media formats from generic files', () => {
    expect(getFileTypeIcon('recording.mp4')).not.toBe(getFileTypeIcon(undefined));
    expect(getFileTypeIcon('recording.mp3')).not.toBe(getFileTypeIcon('recording.mp4'));
  });

  it('uses filename-specific icons and a generic fallback', () => {
    expect(getFileTypeIcon('/workspace/Dockerfile')).toBe(
      getFileTypeIcon('/workspace/.dockerignore')
    );
    expect(getFileTypeIcon('unknown.custom-extension')).toBe(getFileTypeIcon(undefined));
  });
});
