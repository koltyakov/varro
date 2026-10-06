// Chromium services a running main-thread CSS animation on every frame, even when `steps()`
// changes its output only a few times per second. While a stepped waiting indicator is mounted,
// this clock publishes the current step on the root element at each step boundary, and CSS shows
// that same frame without a running animation. Indicators keep their CSS animation until an
// animation event starts the clock, so a missing clock only costs frames, never motion.

interface SteppedAnimation {
  /** The CSS animation an indicator runs before the clock owns it. */
  name: string;
  attribute: string;
  steps: number;
  durationMs: number;
}

// Keep in sync with the stepped-indicator rules in tool-calls.css and messages.css.
const STEPPED_ANIMATIONS: readonly SteppedAnimation[] = [
  { name: 'chat-thinking-shimmer', attribute: 'data-shimmer-step', steps: 12, durationMs: 2000 },
  { name: 'ellipsis', attribute: 'data-ellipsis-step', steps: 4, durationMs: 1000 },
];

const STEPPED_INDICATOR_SELECTOR = [
  '.shimmer-progress:not(.chat-tool-invocation-part *, .manage-models-attention *, .interactive-item-off-core *)',
  '.interactive-item-container .chat-animated-ellipsis:not(.interactive-item-off-core *)',
].join(', ');

const STEPPED_ANIMATION_NAMES = new Set(STEPPED_ANIMATIONS.map((animation) => animation.name));
// Step boundaries accumulate fractional durations such as 2000 / 12 ms.
const BOUNDARY_TOLERANCE_MS = 0.5;

export function startSteppedAnimationClock(doc: Document = document): () => void {
  const root = doc.documentElement;
  const view = doc.defaultView ?? window;
  const schedule = STEPPED_ANIMATIONS.map(() => ({ step: 0, dueAt: 0 }));
  let timer: number | undefined;
  // Advance by scheduled delays rather than wall time, so a paused or faked clock cannot
  // freeze the indicators between steps.
  let now = 0;

  const stop = () => {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
    for (const animation of STEPPED_ANIMATIONS) root.removeAttribute(animation.attribute);
  };

  const tick = () => {
    timer = undefined;
    if (!doc.querySelector(STEPPED_INDICATOR_SELECTOR)) {
      stop();
      return;
    }
    let nextDueAt = Number.POSITIVE_INFINITY;
    STEPPED_ANIMATIONS.forEach((animation, index) => {
      const entry = schedule[index]!;
      if (entry.dueAt <= now + BOUNDARY_TOLERANCE_MS) {
        root.setAttribute(animation.attribute, String(entry.step));
        entry.step = (entry.step + 1) % animation.steps;
        entry.dueAt += animation.durationMs / animation.steps;
      }
      nextDueAt = Math.min(nextDueAt, entry.dueAt);
    });
    const delay = Math.max(0, nextDueAt - now);
    now = nextDueAt;
    timer = view.setTimeout(tick, delay);
  };

  const handleAnimationEvent = (event: AnimationEvent) => {
    if (timer !== undefined || !STEPPED_ANIMATION_NAMES.has(event.animationName)) return;
    now = 0;
    for (const entry of schedule) {
      entry.step = 0;
      entry.dueAt = 0;
    }
    tick();
  };

  // Iteration events restart the clock for an indicator that resumed after the clock stopped,
  // such as a row returning from the paused off-core range.
  doc.addEventListener('animationstart', handleAnimationEvent, true);
  doc.addEventListener('animationiteration', handleAnimationEvent, true);
  return () => {
    doc.removeEventListener('animationstart', handleAnimationEvent, true);
    doc.removeEventListener('animationiteration', handleAnimationEvent, true);
    stop();
  };
}
