import { batch, createSignal, untrack } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { isWorkspaceDirectoryText } from '../../lib/part-utils';
import type { Part } from '../../types';

const COLLECT_MS = 100;
const ACTIVITY_ADMISSION_MS = 120;
const ACTIVITY_PAINT_FALLBACK_MS = 250;
const MIN_ACTIVITY_PREVIEW_MS = 600;
const INITIAL_ACTIVITY_DELAY_MS = 500;
const PREVIEW_MS = 1_200;
const INITIAL_PREVIEW_MS = 2_000;
const TEXT_INTERVAL_MS = 32;
const TEXT_CATCHUP_MS = 256;
const MAX_WAIT_MS = 2_000;
const ACTIVITY_EXIT_MS = 420;
const ACTIVITY_EXIT_GRACE_MS = 250;

type ItemIdentity = { key: string; partId: string };
export type PresentationItem = ItemIdentity &
  (
    | { kind: 'text'; text: string }
    | { kind: 'activity'; running: boolean; active: boolean; expanded: boolean }
    | { kind: 'instant' }
  );
type Burst = {
  showAt: number;
  visibleAt: number | null;
  duration: number;
  nextAdmissionAt: number;
  pendingPaintKey: string | null;
  paintDeadline: number;
};
type Entry = {
  item: PresentationItem;
  arrivedAt: number;
  admitted: boolean;
  text: Accessor<string>;
  setText: Setter<string>;
  pending: Accessor<boolean>;
  setPending: Setter<boolean>;
  target: string;
  catchupAt: number | null;
  nextTextAt: number;
  showAt: number;
  queuedActivity: boolean;
  visibleAt: number | null;
  burst: Burst | null;
  phase: 'delayed' | 'visible' | 'exiting' | 'grouped';
  exitDeadline: number;
  exitGeneration: number;
};

export function getPresentationPartKey(part: Pick<Part, 'messageID' | 'id'>): string {
  return `${part.messageID}\u0000${part.id}`;
}

function sameSet(previous: ReadonlySet<string>, next: ReadonlySet<string>) {
  return previous.size === next.size && [...next].every((key) => previous.has(key));
}

function sameMap(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>) {
  return (
    previous.size === next.size && [...next].every(([key, value]) => previous.get(key) === value)
  );
}

// Prefer readable chunks without waiting for a closing Markdown construct or splitting a code point.
function nextTextEnd(text: string, start: number, count: number) {
  let end = Math.min(text.length, start + count);
  if (end === text.length) return end;
  const boundary = text.slice(end, end + 24).search(/\s/u);
  if (boundary >= 0) end += boundary + 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end += 1;
  return Math.min(text.length, end);
}

/** One view owns deadlines; row remounts only read its current presentation. */
export class StreamingPresentation {
  private entries = new Map<string, Entry>();
  private ordered: Entry[] = [];
  private promotedActivities = new Set<string>();
  private inspectedActivities = new Set<string>();
  private scope: string | null = null;
  private turn: string | null = null;
  private initialized = false;
  private disposed = false;
  private readingSource = false;
  private updating = false;
  private immediate = false;
  private keepRunningVisible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private lastTextReleaseAt = Number.NEGATIVE_INFINITY;
  private readonly membership = createSignal(0);
  private readonly revision = createSignal(0);
  private readonly pendingState = createSignal(false);
  private readonly visibleState = createSignal<ReadonlySet<string>>(new Set(), { equals: sameSet });
  private readonly retainedState = createSignal<ReadonlySet<string>>(new Set(), {
    equals: sameSet,
  });
  private readonly exitingState = createSignal<ReadonlySet<string>>(new Set(), { equals: sameSet });
  private readonly hiddenState = createSignal<ReadonlySet<string>>(new Set(), { equals: sameSet });
  private readonly textGeometryState = createSignal<ReadonlyMap<string, string>>(new Map(), {
    equals: sameMap,
  });

  readonly version = this.revision[0];
  readonly pending = () => {
    this.readSource();
    return this.pendingState[0]();
  };
  readonly visibleActivity = this.visibleState[0];
  readonly retainedActivity = this.retainedState[0];
  readonly exitingActivity = this.exitingState[0];
  readonly hiddenParts = () => {
    this.readSource();
    return this.hiddenState[0]();
  };
  readonly textGeometry = () => {
    this.readSource();
    return this.textGeometryState[0]();
  };

  constructor(
    private readonly callbacks: {
      beforeRead?: () => void;
      beforeExit: (keys: ReadonlySet<string>) => void;
      beforeGroup: (keys: ReadonlySet<string>) => void;
      afterExit: (key: string, complete: () => void) => void;
      afterShow?: (painted: () => void) => void;
      beforeLastExit: () => void;
    }
  ) {}

  readonly textForPart = (part: Part): string | undefined => {
    this.readSource();
    this.membership[0]();
    const entry = this.entries.get(getPresentationPartKey(part));
    return entry?.item.kind === 'text' ? entry.text() : undefined;
  };

  readonly isPartPending = (part: Part): boolean => {
    this.readSource();
    this.membership[0]();
    const entry = this.entries.get(getPresentationPartKey(part));
    return entry?.pending() ?? false;
  };

  update(input: {
    scope: string | null;
    turn: string | null;
    items: readonly PresentationItem[];
    live: boolean;
    immediate: boolean;
    keepRunningVisible?: boolean;
  }): void {
    if (this.disposed) return;
    this.updating = true;
    try {
      untrack(() =>
        batch(() => {
          const reset = this.scope !== input.scope;
          const initial = !this.initialized || reset;
          const replaced = reset || this.turn !== input.turn;
          if (replaced) {
            if (!reset)
              this.callbacks.beforeGroup(
                new Set([...this.visibleActivity(), ...this.retainedActivity()])
              );
            this.clearTimer();
            this.lastTextReleaseAt = Number.NEGATIVE_INFINITY;
            this.entries.clear();
            this.ordered = [];
            this.promotedActivities.clear();
            this.inspectedActivities.clear();
            this.generation += 1;
          }
          this.scope = input.scope;
          this.turn = input.turn;
          this.initialized = true;
          this.immediate = input.immediate;
          this.keepRunningVisible = input.keepRunningVisible ?? false;
          const now = Date.now();
          const next = new Map<string, Entry>();
          let previousBurst: Burst | null = null;
          for (const item of input.items) {
            let entry = this.entries.get(item.key);
            if (entry && entry.item.kind !== item.kind) entry = undefined;
            if (!entry) {
              const paced = !initial && input.live && !input.immediate;
              const activity = item.kind === 'activity' && (paced || (item.running && item.active));
              const text = item.kind === 'text' && !paced ? item.text : '';
              const [displayed, setDisplayed] = createSignal(text);
              const [pending, setPending] = createSignal(false);
              const burst: Burst | null = activity
                ? (previousBurst ?? {
                    showAt: now + (initial ? INITIAL_ACTIVITY_DELAY_MS : COLLECT_MS),
                    visibleAt: null,
                    duration: initial ? INITIAL_PREVIEW_MS : PREVIEW_MS,
                    nextAdmissionAt: 0,
                    pendingPaintKey: null,
                    paintDeadline: 0,
                  })
                : null;
              entry = {
                item,
                arrivedAt: now,
                admitted: !paced,
                text: displayed,
                setText: setDisplayed,
                pending,
                setPending,
                target: text,
                catchupAt: null,
                nextTextAt: now,
                showAt:
                  burst?.visibleAt !== null && burst?.visibleAt !== undefined
                    ? now + COLLECT_MS
                    : (burst?.showAt ?? now),
                burst,
                queuedActivity: paced && item.kind === 'activity',
                visibleAt: null,
                phase: activity ? 'delayed' : 'grouped',
                exitDeadline: 0,
                exitGeneration: 0,
              };
            }
            entry.item = item;
            if (
              item.kind === 'activity' &&
              !item.running &&
              !input.live &&
              entry.phase === 'delayed'
            ) {
              entry.phase = 'grouped';
            }
            if (item.kind === 'activity' && this.promotedActivities.delete(item.key)) {
              entry.phase = 'visible';
              entry.admitted = true;
              entry.visibleAt = now;
              entry.burst = {
                showAt: now,
                visibleAt: now,
                duration: PREVIEW_MS,
                nextAdmissionAt: now + ACTIVITY_ADMISSION_MS,
                pendingPaintKey: null,
                paintDeadline: 0,
              };
            }
            if (item.kind === 'text') {
              if (!initial && previousBurst && item.text && entry.text() !== item.text) {
                previousBurst.duration = Math.min(previousBurst.duration, PREVIEW_MS);
              }
              if (!item.text.startsWith(entry.target)) {
                // Canonical corrections supersede any queued suffix, including shorter snapshots.
                entry.setText(item.text);
                entry.catchupAt = null;
                entry.admitted = true;
              }
              entry.target = item.text;
              if (!input.live) entry.setText(item.text);
            }
            if (item.kind === 'activity')
              previousBurst = entry.phase === 'grouped' ? null : entry.burst;
            else previousBurst = null;
            next.set(item.key, entry);
          }
          const membershipChanged =
            replaced ||
            this.entries.size !== next.size ||
            [...next].some(([key, entry]) => this.entries.get(key) !== entry);
          this.entries = next;
          this.ordered = [...next.values()];
          if (membershipChanged) this.membership[1]((value) => value + 1);
          this.advance(now, false);
        })
      );
    } finally {
      this.updating = false;
    }
  }

  private readSource() {
    if (this.updating || this.readingSource || this.disposed) return;
    this.readingSource = true;
    try {
      this.callbacks.beforeRead?.();
    } finally {
      this.readingSource = false;
    }
  }

  /** Permission removal hands an already painted tool to the tray without another entrance. */
  showActivity(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.item.kind !== 'activity') {
      this.promotedActivities.add(key);
      return;
    }
    entry.phase = 'visible';
    entry.admitted = true;
    entry.visibleAt = Date.now();
    entry.burst = {
      showAt: Date.now(),
      visibleAt: Date.now(),
      duration: PREVIEW_MS,
      nextAdmissionAt: Date.now() + ACTIVITY_ADMISSION_MS,
      pendingPaintKey: null,
      paintDeadline: 0,
    };
    this.advance(Date.now(), false);
  }

  flush(): void {
    if (this.disposed) return;
    this.immediate = true;
    this.keepRunningVisible = false;
    this.advance(Date.now(), true);
  }

  reset(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.generation += 1;
    this.initialized = false;
    this.lastTextReleaseAt = Number.NEGATIVE_INFINITY;
    this.entries.clear();
    this.promotedActivities.clear();
    this.inspectedActivities.clear();
    this.ordered = [];
    this.membership[1]((value) => value + 1);
    this.advance(Date.now(), false);
  }

  canSmoothFollow(): boolean {
    return !this.immediate && Date.now() - this.lastTextReleaseAt < 500;
  }

  inspectActivity(key: string, expanded: boolean): void {
    if (expanded) this.inspectedActivities.add(key);
    else this.inspectedActivities.delete(key);
    const entry = this.entries.get(key);
    if (expanded && entry?.phase === 'exiting') {
      entry.phase = 'visible';
      entry.exitGeneration += 1;
    }
    this.advance(Date.now(), true);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
    this.entries.clear();
    this.promotedActivities.clear();
    this.inspectedActivities.clear();
    this.ordered = [];
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private completeExit(entry: Entry, generation: number, exitGeneration: number) {
    if (
      this.disposed ||
      this.generation !== generation ||
      this.entries.get(entry.item.key) !== entry ||
      entry.phase !== 'exiting' ||
      entry.exitGeneration !== exitGeneration
    )
      return;
    untrack(() =>
      batch(() => {
        entry.phase = 'grouped';
        this.advance(Date.now(), true);
      })
    );
  }

  private advance(now: number, releaseText: boolean) {
    if (this.disposed) return;
    this.clearTimer();
    untrack(() =>
      batch(() => {
        const visible = new Set<string>();
        const retained = new Set<string>();
        const exiting = new Set<string>();
        const hidden = new Set<string>();
        const textGeometry = new Map<string, string>();
        const afterExit: Array<() => void> = [];
        const afterShow: Array<() => void> = [];
        const beginningExits = new Set<string>();
        const directlyGrouped = new Set<string>();
        let blocked = false;
        let blockingBurst: Burst | null = null;
        let pending = false;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const entry of this.ordered) {
          const { item } = entry;
          const expired = now >= entry.arrivedAt + MAX_WAIT_MS;
          const sharesBurst =
            item.kind === 'activity' && entry.burst !== null && entry.burst === blockingBurst;
          const wait = !entry.admitted && blocked && !sharesBurst && !expired && !this.immediate;
          if (wait) nextAt = Math.min(nextAt, entry.arrivedAt + MAX_WAIT_MS);
          if (!wait) entry.admitted = true;

          if (item.kind === 'activity') {
            const inspected = this.inspectedActivities.has(item.key);
            if (
              this.immediate &&
              this.keepRunningVisible &&
              item.running &&
              item.active &&
              entry.phase === 'delayed'
            ) {
              entry.phase = 'visible';
              entry.visibleAt = now;
              if (entry.burst) entry.burst.visibleAt ??= now;
            }
            if (item.running && entry.phase === 'exiting') {
              entry.phase = 'visible';
              entry.exitGeneration += 1;
            }
            if (
              entry.phase !== 'grouped' &&
              (item.expanded ||
                (!item.active && item.running) ||
                (this.immediate && (!item.running || !this.keepRunningVisible)))
            ) {
              directlyGrouped.add(item.key);
              entry.phase = 'grouped';
            }
            if (entry.phase === 'delayed') {
              const admissionAt = Math.max(
                entry.showAt,
                entry.queuedActivity
                  ? Math.max(
                      entry.burst?.nextAdmissionAt ?? 0,
                      entry.burst?.pendingPaintKey ? entry.burst.paintDeadline : 0
                    )
                  : 0
              );
              const previewEnds =
                entry.burst?.visibleAt === null || !entry.burst
                  ? null
                  : entry.burst.visibleAt + entry.burst.duration;
              if (
                entry.queuedActivity &&
                !item.running &&
                previewEnds !== null &&
                previewEnds - Math.max(now, admissionAt) < MIN_ACTIVITY_PREVIEW_MS
              ) {
                // A large completed burst gets a readable sample; overflow joins the disclosure
                // without mounting dozens of clipped cards or extending the answer's deadline.
                entry.phase = 'grouped';
              } else if (!wait && entry.burst && now >= admissionAt) {
                const burst = entry.burst;
                const firstInBurst = burst.visibleAt === null;
                entry.phase = 'visible';
                entry.visibleAt = now;
                burst.visibleAt ??= now;
                if (entry.queuedActivity) {
                  burst.nextAdmissionAt = now + ACTIVITY_ADMISSION_MS;
                  if (this.callbacks.afterShow) {
                    burst.pendingPaintKey = item.key;
                    burst.paintDeadline = now + ACTIVITY_PAINT_FALLBACK_MS;
                    const generation = this.generation;
                    afterShow.push(() =>
                      this.callbacks.afterShow?.(() => {
                        if (
                          this.disposed ||
                          this.generation !== generation ||
                          this.entries.get(item.key) !== entry ||
                          burst.pendingPaintKey !== item.key
                        )
                          return;
                        burst.pendingPaintKey = null;
                        entry.visibleAt = Date.now();
                        if (firstInBurst) burst.visibleAt = entry.visibleAt;
                        burst.nextAdmissionAt = entry.visibleAt + ACTIVITY_ADMISSION_MS;
                        this.advance(Date.now(), false);
                      })
                    );
                  }
                }
              } else {
                hidden.add(item.key);
                if (!wait) nextAt = Math.min(nextAt, Math.max(now + 1, admissionAt));
              }
            }
            if (entry.phase === 'visible') {
              const visibleUntil = Math.max(
                (entry.burst?.visibleAt ?? now) + (entry.burst?.duration ?? PREVIEW_MS),
                (entry.visibleAt ?? now) + MIN_ACTIVITY_PREVIEW_MS
              );
              if (item.running) visible.add(item.key);
              else if (inspected || now < visibleUntil) retained.add(item.key);
              else {
                beginningExits.add(item.key);
                entry.phase = 'exiting';
                entry.exitGeneration += 1;
                entry.exitDeadline = now + ACTIVITY_EXIT_MS + ACTIVITY_EXIT_GRACE_MS;
                const generation = this.generation;
                const exitGeneration = entry.exitGeneration;
                afterExit.push(() =>
                  this.callbacks.afterExit(item.key, () =>
                    this.completeExit(entry, generation, exitGeneration)
                  )
                );
              }
              if (!inspected && now < visibleUntil) nextAt = Math.min(nextAt, visibleUntil);
            }
            if (entry.phase === 'exiting') {
              if (now >= entry.exitDeadline) {
                entry.phase = 'grouped';
              } else {
                exiting.add(item.key);
                nextAt = Math.min(nextAt, entry.exitDeadline);
              }
            }
            const needsMoment =
              !inspected &&
              (entry.phase === 'delayed' ||
                entry.phase === 'exiting' ||
                (entry.phase === 'visible' &&
                  now <
                    Math.max(
                      (entry.burst?.visibleAt ?? now) + (entry.burst?.duration ?? PREVIEW_MS),
                      (entry.visibleAt ?? now) + MIN_ACTIVITY_PREVIEW_MS
                    )));
            if (needsMoment && !blocked) blockingBurst = entry.burst;
            blocked ||= needsMoment;
            pending ||= needsMoment && (!item.running || entry.phase === 'delayed');
            continue;
          }

          if (item.kind === 'instant') {
            if (wait) hidden.add(item.key);
            pending ||= wait;
            continue;
          }

          const displayed = entry.text();
          if (displayed !== entry.target && !wait) {
            entry.catchupAt ??= now + TEXT_CATCHUP_MS;
            if (this.immediate || now >= entry.catchupAt) {
              entry.setText(entry.target);
            } else if (releaseText && now >= entry.nextTextAt) {
              const remainingTicks = Math.max(
                1,
                Math.ceil((entry.catchupAt - now) / TEXT_INTERVAL_MS)
              );
              const count = Math.max(
                24,
                Math.ceil((entry.target.length - displayed.length) / remainingTicks)
              );
              entry.setText(
                entry.target.slice(0, nextTextEnd(entry.target, displayed.length, count))
              );
              entry.nextTextAt = now + TEXT_INTERVAL_MS;
            }
          }
          const text = entry.text();
          if (text !== displayed) this.lastTextReleaseAt = now;
          const textPending = text !== entry.target;
          entry.setPending(textPending);
          if (textPending && !wait) nextAt = Math.min(nextAt, Math.max(now + 1, entry.nextTextAt));
          if (!textPending) entry.catchupAt = null;
          pending ||= textPending;
          if (textPending) blockingBurst = null;
          blocked ||= textPending;
          textGeometry.set(
            item.partId,
            !text.trim() ? '' : isWorkspaceDirectoryText(text) ? '[Working directory:' : 'x'
          );
        }
        if (directlyGrouped.size > 0) this.callbacks.beforeGroup(directlyGrouped);
        if (beginningExits.size > 0) this.callbacks.beforeExit(beginningExits);
        this.visibleState[1](visible);
        this.retainedState[1](retained);
        // Hand off the last disappearing row's reserve before publishing its removal.
        if (this.exitingActivity().size > 0 && exiting.size === 0) this.callbacks.beforeLastExit();
        this.exitingState[1](exiting);
        this.hiddenState[1](hidden);
        this.textGeometryState[1](textGeometry);
        this.pendingState[1](pending);
        this.revision[1]((value) => value + 1);
        for (const callback of afterExit) callback();
        for (const callback of afterShow) callback();
        if (Number.isFinite(nextAt)) {
          const generation = this.generation;
          this.timer = setTimeout(
            () => {
              this.timer = undefined;
              if (generation === this.generation) this.advance(Date.now(), true);
            },
            Math.max(1, nextAt - now)
          );
        }
      })
    );
  }
}
