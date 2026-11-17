// Native images decide paint coverage. DOM samples establish eligibility, not success.
export function verdict(failures, complete) {
  return failures.length ? 'FAIL' : complete ? 'PASS' : 'BLOCKED';
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
      best = Math.max(best, matched / reference.length);
    }
  }
  return best;
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
