export const THUMBNAIL_MAX_INPUT_BYTES = 24 * 1024 * 1024;
export const THUMBNAIL_MAX_OUTPUT_BYTES = 256 * 1024;
export const THUMBNAIL_MAX_EDGE = 384;

export type ThumbnailFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif';
export type ThumbnailInput = Uint8Array<ArrayBuffer> | string | { base64: Uint8Array<ArrayBuffer> };

export type ThumbnailRequest = {
  id: number;
  bytes: ThumbnailInput;
  format: ThumbnailFormat;
};

export type ThumbnailResponse = {
  id: number;
  bytes: Uint8Array<ArrayBuffer> | null;
};
