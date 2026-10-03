import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import {
  ColorSpace,
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickImageInfo,
  MagickReadSettings,
  ResourceLimits,
} from '@imagemagick/magick-wasm';
import {
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_MAX_INPUT_BYTES,
  THUMBNAIL_MAX_OUTPUT_BYTES,
} from './image-thumbnail-protocol';
import type {
  ThumbnailFormat,
  ThumbnailRequest,
  ThumbnailResponse,
} from './image-thumbnail-protocol';

const formats: Record<ThumbnailFormat, MagickFormat> = {
  png: MagickFormat.Png,
  jpeg: MagickFormat.Jpeg,
  webp: MagickFormat.WebP,
  gif: MagickFormat.Gif,
  avif: MagickFormat.Avif,
};
const MAX_PIXELS = 16_000_000;

function thumbnail(request: ThumbnailRequest): Uint8Array<ArrayBuffer> | null {
  if (request.bytes.byteLength > THUMBNAIL_MAX_INPUT_BYTES) return null;
  // Force a supported raster decoder rather than letting the input select a delegate.
  const settings = new MagickReadSettings({
    format: formats[request.format],
    frameIndex: 0,
    frameCount: 1,
  });
  const info = MagickImageInfo.create(request.bytes, settings);
  if (!info.width || !info.height || info.width * info.height > MAX_PIXELS) return null;
  return ImageMagick.read(request.bytes, settings, (image) => {
    if (image.width * image.height > MAX_PIXELS) return null;
    image.autoOrient();
    if (Math.max(image.width, image.height) > THUMBNAIL_MAX_EDGE) {
      image.resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE);
    }
    // Keep a small RGB color profile for browser color management while removing EXIF/comments.
    const profile = image.colorSpace === ColorSpace.sRGB ? image.getColorProfile() : null;
    image.colorSpace = ColorSpace.sRGB;
    image.strip();
    if (profile) image.setProfile(profile);
    image.quality = 80;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bytes = image.write(MagickFormat.WebP, (data) =>
        data.byteLength <= THUMBNAIL_MAX_OUTPUT_BYTES ? Uint8Array.from(data) : null
      );
      if (bytes) return bytes;
      image.resize(
        Math.max(1, Math.floor(image.width / 2)),
        Math.max(1, Math.floor(image.height / 2))
      );
    }
    return null;
  });
}

async function start() {
  const port = parentPort;
  if (!port) throw new Error('Thumbnail codec must run in a worker');
  await initializeImageMagick(await readFile(join(__dirname, 'thumbnail-codec.wasm')));
  ResourceLimits.width = 16_384n;
  ResourceLimits.height = 16_384n;
  ResourceLimits.area = BigInt(MAX_PIXELS);
  ResourceLimits.memory = 128n * 1024n * 1024n;
  ResourceLimits.disk = 0n;
  ResourceLimits.maxMemoryRequest = 128n * 1024n * 1024n;
  ResourceLimits.maxProfileSize = 64n * 1024n;
  port.on('message', (request: ThumbnailRequest) => {
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    try {
      bytes = thumbnail(request);
    } catch {
      // Malformed, unsupported or over-budget images keep the UI placeholder.
    }
    const response: ThumbnailResponse = { id: request.id, bytes };
    port.postMessage(response, bytes ? [bytes.buffer] : []);
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the original runtime initialization error for the host.
void start().catch((error: unknown) => {
  // Initialization errors must reach the host as worker errors and remain retryable.
  setImmediate(() => {
    throw error;
  });
});
