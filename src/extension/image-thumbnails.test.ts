import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  ImageMagick,
  initializeImageMagick,
  MagickColors,
  MagickFormat,
  MagickImage,
} from '@imagemagick/magick-wasm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { thumbnailWorkerBuildOptions } from '../../scripts/build-thumbnail-worker.mjs';
import { smokeThumbnailWorker } from '../../scripts/verify-extension-bundle.mjs';
import { ThumbnailWorkerClient } from './image-thumbnail-worker-client';
import { ImageThumbnails } from './image-thumbnails';

let directory: string;
let client: ThumbnailWorkerClient;
const services: ImageThumbnails[] = [];
const require = createRequire(import.meta.url);

function service() {
  const thumbnails = new ImageThumbnails(client);
  services.push(thumbnails);
  return thumbnails;
}

function source(format: MagickFormat, mime: string, width = 1600, height = 1000) {
  return ImageMagick.read(MagickColors.Red, width, height, (image) =>
    image.write(
      format,
      (data) => `data:image/${mime};base64,${Buffer.from(data).toString('base64')}`
    )
  );
}

function decode(url: string) {
  return ImageMagick.read(Buffer.from(url.split(',')[1]!, 'base64'), (image) => ({
    width: image.width,
    height: image.height,
    profiles: image.profileNames,
    comment: image.comment,
    pixel: image.getPixels((pixels) => Array.from(pixels.toByteArray(0, 0, 1, 1, 'RGBA')!)),
  }));
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'varro-thumbnail test-'));
  await build(thumbnailWorkerBuildOptions(directory));
  await initializeImageMagick(
    await readFile(require.resolve('@imagemagick/magick-wasm/magick.wasm'))
  );
  client = new ThumbnailWorkerClient(join(directory, 'thumbnail-worker.js'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const thumbnails of services.splice(0)) thumbnails.dispose();
});

afterAll(async () => {
  client.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe('WASM thumbnails', () => {
  it.each<[MagickFormat, string]>([
    [MagickFormat.Png, 'png'],
    [MagickFormat.Jpeg, 'jpeg'],
    [MagickFormat.WebP, 'webp'],
    [MagickFormat.Gif, 'gif'],
    [MagickFormat.Avif, 'avif'],
  ])('generates a cold-cache bounded preview from %s', async (format, mime) => {
    const original = source(format, mime);
    const thumbnails = service();
    expect(thumbnails.peek('cli-image')).toBeUndefined();
    const url = await thumbnails.get('cli-image', original);
    expect(url).toMatch(/^data:image\/webp;base64,/);
    expect(url).not.toBe(original);
    expect(decode(url!)).toMatchObject({ width: 384, height: 240, profiles: [] });
    expect(thumbnails.peek('cli-image')).toBe(url);
    expect(await thumbnails.get('cli-image', 'invalid')).toBe(url);
    expect(url!.length).toBeLessThan(350_000);
  });

  it('does not upscale small images and preserves alpha', async () => {
    const original = ImageMagick.read(MagickColors.Transparent, 20, 10, (image) =>
      image.write(
        MagickFormat.Png,
        (data) => `data:image/png;base64,${Buffer.from(data).toString('base64')}`
      )
    );
    const url = await service().get('alpha', original);
    expect(decode(url!)).toMatchObject({ width: 20, height: 10, pixel: [0, 0, 0, 0] });
  });

  it('applies JPEG orientation before resize and removes EXIF and comments', async () => {
    const original = Buffer.from(
      source(MagickFormat.Jpeg, 'jpeg', 800, 400).split(',')[1]!,
      'base64'
    );
    // Independent EXIF APP1 segment: Orientation=6, 90 degrees clockwise.
    const exif = Buffer.from(
      'ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
      'hex'
    );
    const oriented = Buffer.concat([original.subarray(0, 2), exif, original.subarray(2)]);
    const url = await service().get(
      'rotated',
      `data:image/jpeg;base64,${oriented.toString('base64')}`
    );
    expect(decode(url!)).toMatchObject({ width: 192, height: 384, profiles: [] });
  });

  it('serves the first frame of an animated GIF', async () => {
    const original = ImageMagick.readCollection(
      Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      (images) => {
        images.push(MagickImage.create(MagickColors.Blue, 1, 1));
        // The first transparent frame must remain the poster frame.
        return images.write(
          MagickFormat.Gif,
          (data) => `data:image/gif;base64,${Buffer.from(data).toString('base64')}`
        );
      }
    );
    const url = await service().get('animated', original);
    expect(decode(url!).pixel[3]).toBe(0);
  });

  it('generates again after restart, expiry or bounded cache eviction', async () => {
    const original = source(MagickFormat.Png, 'png', 1, 1);
    const thumbnails = service();
    await thumbnails.get('first', original);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    expect(thumbnails.peek('first')).toBeUndefined();
    vi.restoreAllMocks();
    expect(await thumbnails.get('first', original)).toMatch(/^data:image\/webp/);
    for (let i = 0; i < 64; i += 1) await thumbnails.get(`next-${i}`, original);
    expect(thumbnails.peek('first')).toBeUndefined();
    expect(await service().get('first', original)).toMatch(/^data:image\/webp/);
  });

  it('cleans expired entries without reads and without extending TTL on hits', async () => {
    const thumbnails = service();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    await thumbnails.get('first', source(MagickFormat.Png, 'png', 1, 1));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(4 * 60_000);
    expect(thumbnails.peek('first')).toBeDefined();
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(thumbnails.peek('first')).toBeUndefined();
  });

  it('deduplicates consumers while allowing one to cancel independently', async () => {
    const thumbnails = service();
    const convert = vi.spyOn(client, 'convert');
    const original = source(MagickFormat.Png, 'png');
    const controller = new AbortController();
    const cancelled = thumbnails.get('shared', original, controller.signal);
    const retained = thumbnails.get('shared', original);
    controller.abort(new Error('View closed'));
    await expect(cancelled).rejects.toThrow('View closed');
    expect(await retained).toMatch(/^data:image\/webp/);
    expect(convert).toHaveBeenCalledTimes(1);
    convert.mockRestore();
  });

  it('cancels abandoned work and recovers on the next uncached request', async () => {
    const thumbnails = service();
    const original = source(MagickFormat.Png, 'png');
    const controller = new AbortController();
    const pending = thumbnails.get('cancelled', original, controller.signal);
    controller.abort(new Error('View closed'));
    await expect(pending).rejects.toThrow('View closed');
    expect(thumbnails.peek('cancelled')).toBeUndefined();
    expect(await thumbnails.get('cancelled', original)).toMatch(/^data:image\/webp/);
  });

  it('does not fetch URLs, return originals, or permanently cache failures', async () => {
    const thumbnails = service();
    expect(await thumbnails.get('remote', 'https://example.test/image.png')).toBeNull();
    expect(await thumbnails.get('svg', 'data:image/svg+xml;base64,AAAA')).toBeNull();
    expect(await thumbnails.get('broken', 'data:image/png;base64,AAAA')).toBeNull();
    expect(thumbnails.peek('broken')).toBeUndefined();
    expect(await thumbnails.get('broken', source(MagickFormat.Png, 'png', 1, 1))).not.toBeNull();
  });

  it('runs from the self-contained packaged assets, including paths containing spaces', async () => {
    await smokeThumbnailWorker(directory);
  });
});
