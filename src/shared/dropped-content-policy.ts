export const MAX_DROPPED_CONTENT_FILES = 20;
export const MAX_DROPPED_CONTENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_DROPPED_CONTENT_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_DROPPED_DIRECTORY_ENTRIES = 200;

export interface DroppedContentDirectory {
  name: string;
  directories: string[];
}

export function isSafeDroppedRelativePath(path: string): boolean {
  const segments = path.split('/');
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    segments.length <= 32 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !/[\\:]/.test(segment) &&
        !Array.from(segment).some((character) => character.charCodeAt(0) < 32) &&
        !/[. ]$/.test(segment)
    )
  );
}
