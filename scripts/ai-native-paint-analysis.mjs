import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ImageMagick, initializeImageMagick } from '@imagemagick/magick-wasm';
import { brightPixels, glyphContinuity, verdict } from './ai-native-paint-oracles.mjs';

let initialized;
export async function decodeNativeImage(bytes) {
  initialized ??= initializeImageMagick(
    await readFile(createRequire(import.meta.url).resolve('@imagemagick/magick-wasm/magick.wasm'))
  );
  await initialized;
  return ImageMagick.read(bytes, (image) => ({
    width: image.width,
    height: image.height,
    data: image.getPixels(
      (pixels) => new Uint8Array(pixels.toByteArray(0, 0, image.width, image.height, 'RGB'))
    ),
  }));
}

export async function analyzeNativePaint(
  frames,
  samples,
  host,
  readImage,
  prependEpoch,
  { decode = decodeNativeImage, firstMoveEpoch } = {}
) {
  const coldFailures = [];
  const textFailures = [];
  const references = new Map();
  const nodeChanges = new Map();
  const inspected = [];
  let continuityChecks = 0;
  let prependChecks = 0;
  let coldChecks = 0;
  let baseline = false;
  // Fixed native dark-theme oracle. Fail closed if image scale or contrast differs.
  for (const frame of frames) {
    const epoch = frame.metadata.timestamp * 1000;
    const before = samples.findLast((s) => s.epoch <= epoch);
    const after = samples.find((s) => s.epoch >= epoch);
    if (!before || !after || !before.label || before.label !== after.label) continue;
    const image = await decode(await readImage(frame.file));
    const scale = image.width / frame.metadata.deviceWidth;
    if (scale !== 1 || image.height !== frame.metadata.deviceHeight) {
      throw new Error('Native paint oracle requires unscaled 1:1 compositor frames');
    }
    const viewport = before.viewport;
    const body = {
      x: Math.round(host.x + viewport.x + 14),
      y: Math.round(host.y + viewport.y + 140),
      width: Math.floor(viewport.width - 42),
      height: Math.floor(viewport.height - 155),
    };
    const bright = brightPixels(image, body).length;
    const moving =
      firstMoveEpoch === undefined
        ? before.top !== samples[0].top || after.top !== samples[0].top
        : epoch >= firstMoveEpoch;
    if (
      before.label === 'first-top' &&
      !moving &&
      bright > 100 &&
      bright < body.width * body.height * 0.6
    )
      baseline = true;
    const row = { file: frame.file, epoch, top: before.top, bright, markers: [] };
    if (before.label === 'first-top' && baseline && moving) {
      coldChecks++;
      if (bright < 10) coldFailures.push({ file: frame.file, epoch, bright });
    }
    for (const marker of before.markers) {
      const next = after.markers.find((m) => m.node === marker.node);
      const r = marker.rect;
      if (
        !next ||
        Math.abs(next.rect.y - r.y) > 2 ||
        Math.abs(next.rect.x - r.x) > 2 ||
        Math.abs(next.rect.width - r.width) > 1 ||
        marker.text !== next.text ||
        (marker.hits?.length && !marker.hits[0].containsParagraph) ||
        (next.hits?.length && !next.hits[0].containsParagraph) ||
        marker.styles.some(
          (s) => s.opacity !== '1' || s.visibility !== 'visible' || s.display === 'none'
        )
      )
        continue;
      const crop = {
        x: Math.floor(host.x + r.x),
        y: Math.floor(host.y + r.y),
        width: Math.ceil(r.width),
        height: Math.ceil(r.height),
      };
      const key = JSON.stringify([marker.row, marker.text]);
      if (before.markers.filter((m) => m.row === marker.row && m.text === marker.text).length !== 1)
        continue;
      const reference = references.get(key);
      const pixels = brightPixels(image, crop);
      // A reference must actually be painted before the older page is applied.
      if (!reference && epoch < prependEpoch && pixels.length >= 35) {
        references.set(key, {
          node: marker.node,
          text: marker.text,
          points: pixels,
          crop,
          file: frame.file,
          row: marker.row,
        });
      } else if (
        reference &&
        crop.width === reference.crop.width &&
        crop.height === reference.crop.height
      ) {
        const score = glyphContinuity(image, crop, reference.points);
        if (reference.node !== marker.node)
          nodeChanges.set(key, {
            row: marker.row,
            from: reference.node,
            to: marker.node,
            reference: reference.file,
          });
        continuityChecks++;
        if (epoch >= prependEpoch) prependChecks++;
        const check = {
          node: marker.node,
          row: marker.row,
          crop,
          score,
          reference: reference.file,
        };
        row.markers.push(check);
        if (score < 0.65) textFailures.push({ file: frame.file, epoch, ...check });
      }
    }
    inspected.push(row);
  }
  return {
    cold: {
      verdict: verdict(coldFailures, baseline && coldChecks > 5),
      baseline,
      checkedFrames: coldChecks,
      failures: coldFailures,
    },
    retained: {
      verdict: verdict(textFailures, baseline && prependChecks > 2),
      references: [...references.values()].map((reference) => [reference.node, reference]),
      nodeChanges: [...nodeChanges.values()],
      checkedFrames: continuityChecks,
      prependChecks,
      failures: textFailures,
    },
    inspected,
    limits:
      'Dark theme, 1:1 native frames; stable bracketing text bounds; 2 CSS px search. Missing gates stay BLOCKED.',
  };
}
