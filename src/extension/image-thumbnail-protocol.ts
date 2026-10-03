export const THUMBNAIL_MAX_INPUT_BYTES = 24 * 1024 * 1024;
export const THUMBNAIL_MAX_OUTPUT_BYTES = 256 * 1024;
export const THUMBNAIL_MAX_EDGE = 384;

export type ThumbnailFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif';

export type ThumbnailRequest = {
  id: number;
  bytes: Uint8Array<ArrayBuffer>;
  format: ThumbnailFormat;
};

export type ThumbnailResponse = {
  id: number;
  bytes: Uint8Array<ArrayBuffer> | null;
};
