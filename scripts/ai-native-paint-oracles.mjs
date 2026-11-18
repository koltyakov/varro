// Native images decide paint coverage. DOM samples establish eligibility, not success.
export function verdict(failures, complete) {
  return failures.length ? 'FAIL' : complete ? 'PASS' : 'BLOCKED';
}

export function markerPaintEligibility(marker, sample, tolerance = 2) {
  if (!Array.isArray(sample.stickyOccluders)) return 'unknown-sticky-coverage';
  const r = marker.rect;
  const viewport = sample.viewport;
  if (
    r.x - tolerance < viewport.x ||
    r.y - tolerance < viewport.y ||
    r.x + r.width + tolerance > viewport.x + viewport.width ||
    r.y + r.height + tolerance > viewport.y + viewport.height
  )
    return 'clipped';
  if (
    sample.stickyOccluders.some(
      (cover) =>
        r.x - tolerance < cover.x + cover.width &&
        r.x + r.width + tolerance > cover.x &&
        r.y - tolerance < cover.y + cover.height &&
        r.y + r.height + tolerance > cover.y
    )
  )
    return 'sticky-occluded';
  if (
    marker.styles.some(
      (style) => style.opacity !== '1' || style.visibility !== 'visible' || style.display === 'none'
    )
  )
    return 'hidden';
  return null;
}

export function brightPixels(image, rect, threshold = 75) {
  const { x, y, width, height } = rect;
  if (
    ![x, y, width, height].every(Number.isInteger) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > image.width ||
    y + height > image.height
  ) {
    throw new Error('Paint crop lies outside the native image');
  }
  const points = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const offset = ((y + dy) * image.width + x + dx) * 3;
      if (Math.max(...image.data.subarray(offset, offset + 3)) > threshold) points.push([dx, dy]);
    }
  }
  return points;
}

export function glyphContinuity(image, rect, reference, tolerance = 2) {
  // Search only the stated 2 CSS px tolerance, never a later frame or a new node.
  let best = 0;
  for (let dy = -tolerance; dy <= tolerance; dy++) {
    for (let dx = -tolerance; dx <= tolerance; dx++) {
      const points = new Set(
        brightPixels(image, {
          ...rect,
          x: rect.x + dx,
          y: rect.y + dy,
        }).map(([x, y]) => `${x},${y}`)
      );
      const matched = reference.filter(([x, y]) => points.has(`${x},${y}`)).length;
      // Intersection over union penalizes extra bright pixels covering the glyph gaps.
      best = Math.max(best, matched / (reference.length + points.size - matched));
    }
  }
  return best;
}

export function firstAppliedPage(samples, pages, initial) {
  let previous = initial;
  for (const sample of samples) {
    if (sample.epoch <= initial.epoch) continue;
    const id = sample.firstLoadedMessageId;
    if (id && previous.firstLoadedMessageId && id !== previous.firstLoadedMessageId) {
      // Mounted rows are insufficient: scrolling can remount an already-applied page.
      const page = pages.find(
        (entry) =>
          entry.before &&
          entry.status === 200 &&
          entry.finished <= sample.epoch &&
          entry.messageIds?.includes(id) &&
          !entry.messageIds.includes(previous.firstLoadedMessageId)
      );
      if (page) {
        return {
          epoch: sample.epoch,
          referenceDeadline: previous.epoch,
          finished: page.finished,
          before: page.before,
          row: id,
          prefetched: page.finished < initial.epoch,
        };
      }
    }
    previous = sample;
  }
  return null;
}

export function topTargeting(action, samples, pages, firstMessageId) {
  const own = samples.filter((sample) => sample.label === action.name);
  const reachedLoadedTop = own.some((sample) => sample.top <= 1.5);
  const exhausted = pages.some(
    (page) => page.before && page.finished <= action.finished && page.status === 200 && !page.cursor
  );
  const last = own.at(-1);
  const delivered =
    action.held && own.some((sample) => Math.abs(sample.top - action.before.top) > 100);
  const completeTop =
    delivered &&
    exhausted &&
    last?.top <= 1.5 &&
    last.rows.some((row) => row.id === firstMessageId && row.y >= last.viewport.y - 2);
  return {
    verdict: delivered && reachedLoadedTop ? 'PASS' : 'BLOCKED',
    reachedLoadedTop,
    exhausted,
    completeTop,
    delivered,
    // A compensated coordinate after prepend is not a paint failure or a reversal.
    compensation: reachedLoadedTop && !completeTop && (last?.top ?? 0) > 1.5,
  };
}

export function summarizeTrace(events) {
  const counts = {};
  const processes = {};
  const relevant = [];
  for (const event of events) {
    const name = event.name ?? '';
    counts[name] = (counts[name] ?? 0) + 1;
    if (name === 'process_name') processes[event.pid] = event.args?.name;
    if (
      /RasterTask|Paint$|PaintInvalid|Commit|Activate|DrawFrame|Checkerboard|Tile|Scroll|TimeStamp/.test(
        name
      )
    ) {
      relevant.push(event);
    }
  }
  return { counts, processes, relevant };
}
