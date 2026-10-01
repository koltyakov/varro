import { loadImage } from './image-loading';

export type CompressedImage = {
  url: string;
  mime: string;
  size: number;
  width: number;
  height: number;
};

export type ImageCompressionAnalysis = {
  width: number;
  height: number;
  recommended: CompressedImage | null;
  smaller: CompressedImage | null;
};

export function scaledImageDimensions(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function hasMeaningfulImageSavings(originalSize: number, size: number): boolean {
  return size <= originalSize * 0.9 && originalSize - size >= 32 * 1024;
}

async function encodeImage(
  image: HTMLImageElement,
  mime: string,
  maxEdge: number,
  quality: number
): Promise<CompressedImage> {
  const dimensions = scaledImageDimensions(image.naturalWidth, image.naturalHeight, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image compression is unavailable');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('Could not compress the image'))),
        mime,
        quality
      );
    });
    if (blob.type !== mime) throw new Error('This image format cannot be compressed');
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result || '')));
      reader.addEventListener('error', () =>
        reject(new Error('Could not read the compressed image'))
      );
      reader.readAsDataURL(blob);
    });
    return { ...dimensions, url, mime, size: blob.size };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

function isSupportedImage(url: string, mime: string): boolean {
  if (!url.startsWith(`data:${mime};base64,`) || !['image/png', 'image/jpeg'].includes(mime))
    return false;
  if (mime === 'image/jpeg') return true;
  // Animated PNGs must not silently become a single frame.
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) =>
    char.charCodeAt(0)
  );
  const view = new DataView(bytes.buffer);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'acTL') return false;
    if (type === 'IDAT') break;
    offset += view.getUint32(offset) + 12;
  }
  return true;
}

export async function analyzeImageCompression(image: {
  url: string;
  mime: string;
  size: number;
}): Promise<ImageCompressionAnalysis | null> {
  if (!isSupportedImage(image.url, image.mime)) return null;
  const decoded = await loadImage(image.url);
  const width = decoded.naturalWidth;
  const height = decoded.naturalHeight;
  if (
    width * height > 40_000_000 ||
    (Math.max(width, height) <= 2048 && image.size <= 2 * 1024 * 1024)
  )
    return null;
  const recommended = await encodeImage(decoded, image.mime, 2048, 0.85);
  const smaller = await encodeImage(decoded, image.mime, 1280, 0.7);
  return {
    width,
    height,
    recommended: hasMeaningfulImageSavings(image.size, recommended.size) ? recommended : null,
    smaller: hasMeaningfulImageSavings(image.size, smaller.size) ? smaller : null,
  };
}

export function formatImageBytes(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(size / 1024)} KB`;
}
