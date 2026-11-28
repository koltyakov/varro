import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ImageMagick, initializeImageMagick } from '@imagemagick/magick-wasm';
import {
  brightPixels,
  glyphContinuity,
  markerPaintEligibility,
  verdict,
} from './ai-native-paint-oracles.mjs';

const GLYPH_MATCH_THRESHOLD = 0.65;

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

function markerCrop(marker, host) {
  const { x, y, width, height } = marker.rect;
  return {
    x: Math.floor(host.x + x),
    y: Math.floor(host.y + y),
    width: Math.ceil(width),
    height: Math.ceil(height),
  };
}

function sameCropSize(left, right) {
  return left.width === right.width && left.height === right.height;
}

function uniqueMarker(sample, marker) {
  const matches = sample.markers.filter(
    (item) => item.row === marker.row && item.text === marker.text
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function oldHeldCrop(marker, before, after, host) {
  const old = uniqueMarker(after, marker);
  if (
    !old ||
    markerPaintEligibility(old, after) ||
    (old.hits?.length && !old.hits[0].containsParagraph)
  )
    return;
  const previous = uniqueMarker(before, marker);
  if (
    !previous ||
    previous.node !== old.node ||
    markerPaintEligibility(previous, before) ||
    (previous.hits?.length && !previous.hits[0].containsParagraph)
  )
    return;
  const crop = markerCrop(old, host);
  const prior = markerCrop(previous, host);
  if (sameCropSize(crop, prior) && crop.x === prior.x && crop.y === prior.y) return crop;
}

/**
 * Classifies native compositor frames captured during labelled wheel steps (`<setting>:<index>`).
 * A frame counts only between two DOM samples of the same step. The body crop excludes sticky
 * chrome, the scrollbar, and the jump-to-latest control, so a solid frame is a paint gap.
 */
export async function analyzeWheelPaint(
  frames,
  samples,
  host,
  readImage,
  { decode = decodeNativeImage, maxDelta = 800 } = {}
) {
  const settings = new Map();
  const setting = (name) => {
    if (!settings.has(name))
      settings.set(name, {
        checkedFrames: 0,
        baseline: false,
        moved: false,
        diffGate: false,
        oversizedSteps: [],
        failures: [],
      });
    return settings.get(name);
  };
  for (const sample of samples) {
    if (!sample.label) continue;
    const [name, , delta] = sample.label.split(':');
    const entry = setting(name);
    if (Math.abs(Number(delta)) > maxDelta && !entry.oversizedSteps.includes(sample.label))
      entry.oversizedSteps.push(sample.label);
    if (sample.diffLines > 0) entry.diffGate = true;
  }
  for (const [name, entry] of settings) {
    const own = samples.filter((sample) => sample.label?.startsWith(`${name}:`));
    entry.moved = own.some((sample) => Math.abs(sample.top - own[0].top) > 1);
  }
  for (const frame of frames) {
    const epoch = frame.metadata.timestamp * 1000;
    const before = samples.findLast((s) => s.epoch <= epoch);
    const after = samples.find((s) => s.epoch >= epoch);
    if (!before?.label || before.label !== after?.label) continue;
    const image = await decode(await readImage(frame.file));
    if (
      image.width / frame.metadata.deviceWidth !== 1 ||
      image.height !== frame.metadata.deviceHeight
    )
      throw new Error('Native paint oracle requires unscaled 1:1 compositor frames');
    const viewport = before.viewport;
    const body = {
      x: Math.round(host.x + viewport.x + 14),
      y: Math.round(host.y + viewport.y + 140),
      width: Math.floor(viewport.width - 42),
      height: Math.floor(viewport.height - 200),
    };
    const bright = brightPixels(image, body).length;
    const entry = setting(before.label.split(':')[0]);
    entry.checkedFrames++;
    if (bright > 100 && bright < body.width * body.height * 0.6) entry.baseline = true;
    if (bright < 10 || body.width * body.height - bright < 10)
      // `uncovered` is diagnostic only: mounted rows missing from the viewport at the
      // next DOM sample, as opposed to mounted content the compositor had not painted.
      entry.failures.push({
        file: frame.file,
        epoch,
        label: before.label,
        bright,
        uncovered: after.uncovered,
      });
  }
  const result = {};
  for (const [name, entry] of settings) {
    const complete =
      entry.baseline &&
      entry.moved &&
      entry.checkedFrames > 5 &&
      entry.oversizedSteps.length === 0 &&
      (name !== 'on' || entry.diffGate);
    result[name] = { verdict: verdict(entry.failures, complete), ...entry };
  }
  return result;
}

export async function analyzeNativePaint(
  frames,
  samples,
  host,
  readImage,
  prependEpoch,
  { decode = decodeNativeImage, firstMoveEpoch, referenceDeadline = prependEpoch } = {}
) {
  const coldFailures = [];
  const textFailures = [];
  // The contract is retention through prepend. Earlier comparisons stay as diagnostics:
  // during movement a frame can be misregistered against its bracketing DOM samples.
  const prePrependMismatches = [];
  const prePrependMismatchKeys = new Set();
  const references = new Map();
  const nodeChanges = new Map();
  const inspected = [];
  const excludedMarkers = [];
  const continuityFrames = new Set();
  const prependFrames = new Set();
  const oldLayoutFrames = [];
  const oldIndex = samples.findLastIndex(
    (sample) => sample.epoch <= referenceDeadline && sample.epoch < prependEpoch
  );
  const oldBefore = samples[oldIndex - 1];
  const oldAfter = samples[oldIndex];
  const prependSample = samples.find((sample) => sample.epoch === prependEpoch);
  const heldPrepend =
    oldBefore?.held &&
    oldAfter?.held &&
    prependSample?.held &&
    oldAfter.firstLoadedMessageId &&
    prependSample.firstLoadedMessageId &&
    oldAfter.firstLoadedMessageId !== prependSample.firstLoadedMessageId &&
    oldBefore.firstLoadedMessageId === oldAfter.firstLoadedMessageId &&
    oldBefore.label === oldAfter.label &&
    oldAfter.label === prependSample.label &&
    oldBefore.top === oldAfter.top &&
    oldAfter.top === prependSample.top;
  let presentedNewLayout = false;
  let continuityMarkers = 0;
  let prependMarkers = 0;
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
      if (bright < 10 || body.width * body.height - bright < 10)
        coldFailures.push({ file: frame.file, epoch, bright });
    }
    const comparisons = [];
    for (const marker of before.markers) {
      const next = after.markers.find((m) => m.node === marker.node);
      const r = marker.rect;
      const exclusion =
        markerPaintEligibility(marker, before) ??
        (next ? markerPaintEligibility(next, after) : null);
      if (exclusion) {
        excludedMarkers.push({ file: frame.file, epoch, row: marker.row, reason: exclusion });
        continue;
      }
      if (
        !next ||
        Math.abs(next.rect.y - r.y) > 2 ||
        Math.abs(next.rect.x - r.x) > 2 ||
        Math.abs(next.rect.width - r.width) > 1 ||
        marker.text !== next.text ||
        (marker.hits?.length && !marker.hits[0].containsParagraph) ||
        (next.hits?.length && !next.hits[0].containsParagraph)
      )
        continue;
      const crop = markerCrop(marker, host);
      const key = JSON.stringify([marker.row, marker.text]);
      if (!uniqueMarker(before, marker)) continue;
      const reference = references.get(key);
      // A reference must actually be painted before the older page is applied.
      if (!reference && epoch < referenceDeadline) {
        const pixels = brightPixels(image, crop);
        if (pixels.length >= 35 && pixels.length < crop.width * crop.height * 0.6) {
          references.set(key, {
            node: marker.node,
            text: marker.text,
            points: pixels,
            crop,
            file: frame.file,
            row: marker.row,
          });
        }
      } else if (reference && sameCropSize(crop, reference.crop)) {
        comparisons.push({
          key,
          marker,
          reference,
          crop,
          score: glyphContinuity(image, crop, reference.points),
        });
      }
    }
    const afterPrepend = epoch >= prependEpoch;
    if (
      afterPrepend &&
      !presentedNewLayout &&
      heldPrepend &&
      before.held &&
      after.held &&
      before.label === oldAfter.label &&
      before.top === oldAfter.top &&
      after.top === before.top &&
      before.firstLoadedMessageId === prependSample.firstLoadedMessageId &&
      after.firstLoadedMessageId === before.firstLoadedMessageId
    ) {
      // A screencast can still carry the old layout after the new one has reached the DOM.
      // Register the whole frame to the old layout only with positive, exact evidence:
      // every displaced witness must match there, and none may match its new crop.
      const displaced = comparisons.flatMap((entry) => {
        const oldCrop = oldHeldCrop(entry.marker, oldBefore, oldAfter, host);
        return oldCrop &&
          sameCropSize(oldCrop, entry.crop) &&
          (Math.abs(oldCrop.x - entry.crop.x) > 4 || Math.abs(oldCrop.y - entry.crop.y) > 4)
          ? [{ ...entry, oldCrop }]
          : [];
      });
      presentedNewLayout = displaced.some(({ score }) => score >= GLYPH_MATCH_THRESHOLD);
      if (
        !presentedNewLayout &&
        displaced.length &&
        displaced.every(
          ({ oldCrop, reference }) => glyphContinuity(image, oldCrop, reference.points, 0) === 1
        )
      ) {
        oldLayoutFrames.push({
          file: frame.file,
          epoch,
          rows: displaced.map(({ marker }) => marker.row),
        });
        inspected.push({ ...row, layout: 'pre-prepend' });
        continue;
      }
    }
    for (const { key, marker, reference, crop, score } of comparisons) {
      if (reference.node !== marker.node)
        nodeChanges.set(key, {
          row: marker.row,
          from: reference.node,
          to: marker.node,
          reference: reference.file,
        });
      continuityFrames.add(epoch);
      continuityMarkers++;
      if (afterPrepend) {
        prependFrames.add(epoch);
        prependMarkers++;
      }
      const check = {
        node: marker.node,
        row: marker.row,
        crop,
        score,
        reference: reference.file,
        afterPrepend,
      };
      row.markers.push(check);
      if (score < GLYPH_MATCH_THRESHOLD) {
        if (!afterPrepend) {
          prePrependMismatchKeys.add(key);
          prePrependMismatches.push({ file: frame.file, epoch, ...check });
        } else {
          textFailures.push({
            file: frame.file,
            epoch,
            ...check,
            // Not a pass condition: flags a reference that may itself be misregistered.
            referenceMismatchedBeforePrepend: prePrependMismatchKeys.has(key),
          });
        }
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
      verdict: verdict(textFailures, baseline && prependFrames.size > 2),
      references: [...references.values()].map((reference) => [reference.node, reference]),
      nodeChanges: [...nodeChanges.values()],
      checkedFrames: continuityFrames.size,
      prependChecks: prependFrames.size,
      checkedMarkers: continuityMarkers,
      prependMarkers,
      failures: textFailures,
      prePrependMismatches,
      oldLayoutFrames,
      excludedMarkers,
    },
    inspected,
    limits:
      'Dark theme, 1:1 native frames; stable bracketing text bounds and measured sticky coverage; 2 CSS px search. A held frame with exact evidence of the old layout does not count toward post-prepend coverage. Earlier mismatches are diagnostics. Missing gates stay BLOCKED.',
  };
}
