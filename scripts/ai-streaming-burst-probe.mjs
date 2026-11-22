// Read-only frame observation, shared by live/editor replay and synthetic diagnostics.
export function installBurstProbe() {
  if (globalThis.varroBurstProbe) throw new Error('Burst probe already installed');
  const frames = [];
  const commits = [];
  const events = [];
  const longtasks = [];
  const ids = new WeakMap();
  let nextID = 0;
  let running = false;
  let raf = 0;
  let startedAt = 0;
  let previousNodes = [];
  let lastText = '';
  let droppedSamples = 0;
  const taskObserver = globalThis.PerformanceObserver?.supportedEntryTypes.includes('longtask')
    ? new PerformanceObserver((list) => {
        for (const task of list.getEntries())
          longtasks.push({ at: task.startTime, duration: task.duration });
      })
    : null;
  const onMessage = (message) => {
    if (!running || message.data?.type !== 'server/event') return;
    const event = message.data.payload;
    if (event) events.push({ at: performance.now(), type: event.type });
  };
  const sample = (at) => {
    if (!running) return;
    const list = document.querySelector('.interactive-list');
    if (list) {
      const viewport = list.getBoundingClientRect();
      const sticky = document.querySelector('.latest-user-message-sticky');
      const stickyBox = sticky?.getBoundingClientRect();
      const cutoff =
        stickyBox && stickyBox.height > 0 ? Math.max(viewport.top, stickyBox.bottom) : viewport.top;
      const candidates = [...list.querySelectorAll('.rendered-markdown p, .rendered-markdown pre')];
      const nodes = candidates
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.bottom > cutoff && box.top < viewport.bottom && box.height > 0;
        })
        .slice(0, 8);
      const combined = [...new Set([...nodes, ...previousNodes])];
      const markers = combined.flatMap((node) => {
        if (!node.isConnected) return [];
        const box = node.getBoundingClientRect();
        let upper = Math.max(cutoff, box.top);
        let lower = Math.min(viewport.bottom, box.bottom);
        let painted = true;
        for (
          let parent = node;
          parent && parent !== list.parentElement;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          )
            painted = false;
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            const clip = parent.getBoundingClientRect();
            upper = Math.max(upper, clip.top);
            lower = Math.min(lower, clip.bottom);
          }
        }
        if (!ids.has(node)) ids.set(node, ++nextID);
        const text = node.textContent ?? '';
        return [
          {
            id: ids.get(node),
            top: box.top,
            bottom: box.bottom,
            painted: painted && lower - upper >= 2,
            signature: `${text.length}:${text.slice(0, 64)}:${text.slice(-24)}`,
            messageID: node.closest('[data-msg-id]')?.getAttribute('data-msg-id'),
          },
        ];
      });
      previousNodes = nodes;
      const current =
        list.querySelector('[data-msg-id="burst-current-assistant"]') ??
        [...list.querySelectorAll('[data-msg-id]')].at(-1);
      const text = [...(current?.querySelectorAll('.rendered-markdown') ?? [])]
        .map((node) => node.textContent ?? '')
        .join('');
      if (text !== lastText) {
        commits.push({ at, length: text.length });
        lastText = text;
      }
      if (frames.length < 60000)
        frames.push({
          at,
          top: list.scrollTop,
          height: list.scrollHeight,
          client: list.clientHeight,
          hidden: document.hidden,
          mounted: list.querySelectorAll('[data-msg-id]').length,
          textLength: text.length,
          markers,
          reserve:
            list.querySelector('.append-scroll-bottom-reserve')?.getBoundingClientRect().height ??
            0,
          previews: list.querySelectorAll('.assistant-active-activity-item').length,
        });
      else droppedSamples++;
    }
    raf = requestAnimationFrame(sample);
  };
  globalThis.varroBurstProbe = {
    start() {
      startedAt = performance.now();
      running = true;
      taskObserver?.observe({ type: 'longtask' });
      window.addEventListener('message', onMessage);
      raf = requestAnimationFrame(sample);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('message', onMessage);
      taskObserver?.disconnect();
      delete globalThis.varroBurstProbe;
      return {
        startedAt,
        stoppedAt: performance.now(),
        frames,
        commits,
        events,
        longtasks,
        longtasksSupported: taskObserver !== null,
        droppedSamples,
      };
    },
  };
  return { installed: true };
}

export function analyzeBurstProbe(data) {
  const reversals = [];
  const excessiveSpeed = [];
  const coordinateOnly = [];
  const velocityChanges = [];
  const abruptStarts = [];
  const gaps = [];
  const movingSpeeds = [];
  let lastSpeed = 0;
  for (let index = 1; index < data.frames.length; index++) {
    const previous = data.frames[index - 1];
    const frame = data.frames[index];
    const interval = frame.at - previous.at;
    const precedingInterval = index > 1 ? previous.at - data.frames[index - 2].at : interval;
    // A sampler registered before following sees the preceding callback's write. The larger
    // adjacent frame interval avoids calling a refresh-rate transition a speed violation.
    const budgetInterval = Math.max(interval, precedingInterval, 1);
    const delta = frame.top - previous.top;
    const shared = previous.markers
      .filter((marker) => marker.painted)
      .flatMap((marker) => {
        const next = frame.markers.find(
          (candidate) => candidate.id === marker.id && candidate.signature === marker.signature
        );
        return next
          ? [
              {
                id: marker.id,
                dy: next.top - marker.top,
                documentDelta: next.top - marker.top + delta,
                before: marker,
                after: next,
              },
            ]
          : [];
      });
    const backward = shared.find((marker) => marker.dy > 1);
    if (delta < -1 && backward)
      reversals.push({
        at: frame.at - data.startedAt,
        delta,
        marker: backward,
        interval,
        heightDelta: frame.height - previous.height,
      });
    const forward = shared.find((marker) => Math.abs(marker.documentDelta) <= 2 && marker.dy < -1);
    const speed = delta > 0 ? (delta / budgetInterval) * 1000 : 0;
    if (delta > 2.2 * budgetInterval + 2) {
      const item = {
        at: frame.at - data.startedAt,
        delta,
        interval,
        budgetInterval,
        speedPxPerSecond: speed,
        marker: forward ?? null,
      };
      if (forward) excessiveSpeed.push(item);
      else coordinateOnly.push(item);
    }
    if (forward && delta > 1) {
      movingSpeeds.push(speed);
      velocityChanges.push(Math.abs(speed - lastSpeed));
      if (lastSpeed <= 200 && speed >= 1500 && budgetInterval <= 32)
        abruptStarts.push({
          at: frame.at - data.startedAt,
          fromPxPerSecond: lastSpeed,
          toPxPerSecond: speed,
          interval,
        });
    }
    lastSpeed = speed;
    if (interval > 50) gaps.push({ at: frame.at - data.startedAt, interval });
  }
  const percentile = (values, fraction) =>
    values.length
      ? values.toSorted((a, b) => a - b)[
          Math.min(values.length - 1, Math.floor(values.length * fraction))
        ]
      : null;
  const commitGaps = data.commits.slice(1).map((entry, index) => entry.at - data.commits[index].at);
  const sustained = [];
  for (let index = 1; index < data.frames.length; index++) {
    const end = data.frames[index];
    const start = data.frames.find((frame) => frame.at >= end.at - 120);
    if (!start || end.at - start.at < 90) continue;
    const marker = start.markers.find(
      (candidate) =>
        candidate.painted &&
        end.markers.some(
          (next) => next.id === candidate.id && next.signature === candidate.signature
        )
    );
    const next = marker && end.markers.find((candidate) => candidate.id === marker.id);
    if (!next || Math.abs(next.top - marker.top + end.top - start.top) > 2) continue;
    sustained.push(((end.top - start.top) / (end.at - start.at)) * 1000);
  }
  return {
    frames: data.frames.length,
    durationMs: data.stoppedAt - data.startedAt,
    hiddenFrames: data.frames.filter((frame) => frame.hidden).length,
    droppedSamples: data.droppedSamples,
    maxMountedRows: Math.max(0, ...data.frames.map((frame) => frame.mounted)),
    reversals,
    excessiveSpeed,
    coordinateOnly,
    maxFrameGapMs: Math.max(
      0,
      ...data.frames.slice(1).map((frame, index) => frame.at - data.frames[index].at)
    ),
    gapsAbove50: gaps.length,
    gaps,
    longtasks: data.longtasks,
    longtasksSupported: data.longtasksSupported,
    maxVerifiedFrameSpeedPxPerSecond: movingSpeeds.length ? Math.max(...movingSpeeds) : null,
    p95VerifiedFrameSpeedPxPerSecond: percentile(movingSpeeds, 0.95),
    maxSustainedSpeedPxPerSecond: sustained.length ? Math.max(...sustained) : null,
    p95VelocityChangePxPerSecond: percentile(velocityChanges, 0.95),
    maxVelocityChangePxPerSecond: velocityChanges.length ? Math.max(...velocityChanges) : null,
    abruptStarts,
    textCommits: data.commits.length,
    p95TextCommitGapMs: percentile(commitGaps, 0.95),
    maxTextCommitGapMs: commitGaps.length ? Math.max(...commitGaps) : null,
    eventCount: data.events.length,
    eventTypes: [...new Set(data.events.map((event) => event.type))],
    finalBottomGap: data.frames.at(-1)
      ? data.frames.at(-1).height - data.frames.at(-1).client - data.frames.at(-1).top
      : null,
    timing: 'Recorded frame/event timestamps only. No assumed original-session timing.',
  };
}
