import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from '../test-fixtures';
import {
  analyzeImageCompression,
  hasMeaningfulImageSavings,
  scaledImageDimensions,
} from './image-compression';

const jpeg = { url: 'data:image/jpeg;base64,AAAA', mime: 'image/jpeg', size: 3 * 1024 * 1024 };
let width = 4000;
let height = 2000;
let outputSize = 100_000;
const drawImage = vi.fn();

beforeEach(() => {
  width = 4000;
  height = 2000;
  outputSize = 100_000;
  drawImage.mockClear();
  class DecodedImage extends EventTarget {
    naturalWidth = width;
    naturalHeight = height;
    set src(_url: string) {
      queueMicrotask(() => this.dispatchEvent(new Event('load')));
    }
  }
  vi.stubGlobal('Image', DecodedImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fixture<CanvasRenderingContext2D>({ drawImage })
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, mime) {
    callback(new Blob(['x'.repeat(outputSize)], { type: mime }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('image compression', () => {
  it('preserves aspect ratio and never upscales', () => {
    expect(scaledImageDimensions(4000, 2000, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(scaledImageDimensions(400, 800, 2048)).toEqual({ width: 400, height: 800 });
    expect(scaledImageDimensions(1, 4000, 1280)).toEqual({ width: 1, height: 1280 });
  });
  it('requires both relative and absolute savings', () => {
    expect(hasMeaningfulImageSavings(1_000_000, 900_000)).toBe(true);
    expect(hasMeaningfulImageSavings(1_000_000, 950_000)).toBe(false);
    expect(hasMeaningfulImageSavings(10_000, 1000)).toBe(false);
  });
  it('prepares presets with measured encoded sizes', async () => {
    const result = await analyzeImageCompression(jpeg);
    expect(result?.recommended).toMatchObject({
      width: 2048,
      height: 1024,
      size: outputSize,
      mime: 'image/jpeg',
    });
    expect(result?.smaller).toMatchObject({ width: 1280, height: 640, size: outputSize });
    expect(result?.recommended?.url).toMatch(/^data:image\/jpeg;base64,/);
  });
  it('does not offer small images or larger output', async () => {
    width = height = 1000;
    expect(await analyzeImageCompression({ ...jpeg, size: 100_000 })).toBeNull();
    outputSize = jpeg.size;
    expect(await analyzeImageCompression(jpeg)).toMatchObject({ recommended: null, smaller: null });
  });
  it('skips animations and unsupported formats', async () => {
    expect(await analyzeImageCompression({ ...jpeg, mime: 'image/gif' })).toBeNull();
    const apng = btoa('\x89PNG\r\n\x1a\n\x00\x00\x00\x08acTL' + '\x00'.repeat(12));
    expect(
      await analyzeImageCompression({
        ...jpeg,
        mime: 'image/png',
        url: `data:image/png;base64,${apng}`,
      })
    ).toBeNull();
    expect(drawImage).not.toHaveBeenCalled();
  });
  it('retains PNG encoding rather than flattening transparency into JPEG', async () => {
    const image = {
      size: jpeg.size,
      mime: 'image/png',
      url: `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\n')}`,
    };
    const result = await analyzeImageCompression(image);
    expect(result?.recommended?.mime).toBe('image/png');
    expect(result?.recommended?.url).toMatch(/^data:image\/png;base64,/);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/png',
      0.85
    );
  });
  it('bounds decoded pixel count', async () => {
    width = height = 10_000;
    expect(await analyzeImageCompression(jpeg)).toBeNull();
  });
  it('reports encoder failures without returning a replacement', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => callback(null));
    await expect(analyzeImageCompression(jpeg)).rejects.toThrow('Could not compress');
  });
});
