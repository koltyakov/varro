import { batch, createSignal, untrack } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { isWorkspaceDirectoryText } from '../../lib/part-utils';
import type { Part } from '../../types';

const COLLECT_MS = 100;
const ACTIVITY_ADMISSION_MS = 120;
const MAX_VISIBLE_ACTIVITY = 1;
const SHORT_ACTIVITY_MS = 500;
const LONG_TOOL_MS = 3_000;
const TOOL_ROTATION_MS = 1_000;
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
    | {
        kind: 'activity';
        running: boolean;
        active: boolean;
        expanded: boolean;
        animateExit: boolean;
        startedAt?: number;
        durationMs?: number;
      }
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
  previewUntil: number | null;
  burst: Burst | null;
  phase: 'delayed' | 'visible' | 'paused' | 'exiting' | 'grouped';
  exitDeadline: number;
  exitGeneration: number;
};

type ToolRotation = {
  anchorKey: string;
  currentKey: string;
  lastQueuedKey: string;
  until: number;
};

export function getPresentationPartKey(part: Pick<Part, 'messageID' | 'id'>): string {
  return `${part.messageID}\u0000${part.id}`;
}

function activityPreviewDeadline(entry: Entry, now: number): number {
  if (entry.previewUntil !== null) return entry.previewUntil;
  return Math.max(
    (entry.burst?.visibleAt ?? now) + (entry.burst?.duration ?? PREVIEW_MS),
    (entry.visibleAt ?? now) + MIN_ACTIVITY_PREVIEW_MS
  );
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
  private scheduled: Entry[] = [];
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
  private toolRotation: ToolRotation | null = null;
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
      beforeReplaceActivity?: (key: string) => void;
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

  // The full text queued for display, which can lead the paced prefix by one or more releases.
  readonly targetTextForPart = (part: Part): string | undefined => {
    this.readSource();
    this.membership[0]();
    const entry = this.entries.get(getPresentationPartKey(part));
    return entry?.item.kind === 'text' ? entry.target : undefined;
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
            this.scheduled = [];
            this.promotedActivities.clear();
            this.inspectedActivities.clear();
            this.toolRotation = null;
            this.generation += 1;
          }
          this.scope = input.scope;
          this.turn = input.turn;
          this.initialized = true;
          this.immediate = input.immediate;
          this.keepRunningVisible = input.keepRunningVisible ?? false;
          const now = Date.now();
          let nextOrder: Entry[] | undefined;
          let itemIndex = 0;
          let membershipChanged = replaced;
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
                previewUntil: null,
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
              entry.phase = 'delayed';
              entry.admitted = true;
              entry.showAt = now;
              entry.queuedActivity = false;
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
            if (this.entries.get(item.key) !== entry) {
              this.entries.set(item.key, entry);
              membershipChanged = true;
            }
            if (!nextOrder && this.ordered[itemIndex] !== entry)
              nextOrder = this.ordered.slice(0, itemIndex);
            nextOrder?.push(entry);
            itemIndex += 1;
          }
          if (itemIndex !== this.ordered.length) nextOrder ??= this.ordered.slice(0, itemIndex);
          if (nextOrder) {
            this.ordered = nextOrder;
            if (this.entries.size !== nextOrder.length) {
              this.entries = new Map(nextOrder.map((entry) => [entry.item.key, entry]));
              membershipChanged = true;
            }
          }
          this.refreshScheduled();
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

  /** Permission removal hands an already painted tool to the next available tray slot. */
  showActivity(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.item.kind !== 'activity') {
      this.promotedActivities.add(key);
      return;
    }
    if (entry.phase !== 'visible') entry.phase = 'delayed';
    entry.admitted = true;
    entry.showAt = Date.now();
    entry.queuedActivity = false;
    entry.burst = {
      showAt: Date.now(),
      visibleAt: Date.now(),
      duration: PREVIEW_MS,
      nextAdmissionAt: Date.now() + ACTIVITY_ADMISSION_MS,
      pendingPaintKey: null,
      paintDeadline: 0,
    };
    this.refreshScheduled();
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
    this.toolRotation = null;
    this.ordered = [];
    this.scheduled = [];
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
    this.toolRotation = null;
    this.ordered = [];
    this.scheduled = [];
  }

  private refreshScheduled() {
    // Grouped activities retain their disclosure identity, but own no deadlines or geometry.
    this.scheduled = this.ordered.filter(
      (entry) => entry.item.kind !== 'activity' || entry.phase !== 'grouped'
    );
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

  private canRotateTool(entry: Entry): boolean {
    const { item } = entry;
    return (
      item.kind === 'activity' &&
      !item.animateExit &&
      item.active &&
      !item.expanded &&
      !this.inspectedActivities.has(item.key)
    );
  }

  private advanceToolRotation(
    now: number,
    leavingTray: Set<string>,
    afterShow: Array<() => void>
  ): number {
    if (this.immediate) {
      this.toolRotation = null;
      return Number.POSITIVE_INFINITY;
    }
    let rotation = this.toolRotation;
    const current = rotation ? this.entries.get(rotation.currentKey) : undefined;
    if (current?.phase === 'visible' && this.inspectedActivities.has(current.item.key))
      return Number.POSITIVE_INFINITY;
    const anchor = rotation ? this.entries.get(rotation.anchorKey) : undefined;
    if (
      rotation &&
      (!anchor ||
        anchor.phase === 'grouped' ||
        !this.canRotateTool(anchor) ||
        anchor.item.kind !== 'activity' ||
        !anchor.item.running)
    ) {
      this.toolRotation = null;
      rotation = null;
    }
    if (rotation && current?.phase === 'visible' && now < rotation.until) return rotation.until;

    const visible = this.scheduled.find(
      (entry) => entry.phase === 'visible' && this.canRotateTool(entry)
    );
    const primary = rotation ? anchor : visible;
    if (!primary || primary.item.kind !== 'activity' || !primary.item.running)
      return Number.POSITIVE_INFINITY;

    const candidates = this.scheduled.filter(
      (entry) =>
        entry !== primary &&
        (entry.phase === 'delayed' || entry.phase === 'paused') &&
        this.canRotateTool(entry)
    );
    let next: Entry | undefined;
    if (rotation && rotation.currentKey !== rotation.anchorKey) next = primary;
    else {
      next = candidates.find((entry) => entry.phase === 'delayed');
      if (!next && candidates.length > 0) {
        const previousIndex = candidates.findIndex(
          (entry) => entry.item.key === rotation?.lastQueuedKey
        );
        next = candidates[(previousIndex + 1) % candidates.length];
      }
    }
    if (!next) {
      this.toolRotation = null;
      return Number.POSITIVE_INFINITY;
    }
    const rotateAt = rotation
      ? next.showAt
      : Math.max(
          (primary.item.startedAt ?? primary.arrivedAt) + LONG_TOOL_MS,
          (primary.visibleAt ?? now) + MIN_ACTIVITY_PREVIEW_MS,
          primary.previewUntil ?? 0,
          next.showAt
        );
    if (now < rotateAt) return rotateAt;

    if (visible && visible !== next) {
      leavingTray.add(visible.item.key);
      visible.phase = 'paused';
    }
    next.phase = 'visible';
    next.admitted = true;
    next.visibleAt = now;
    next.previewUntil = now + TOOL_ROTATION_MS;
    const slice: ToolRotation = {
      anchorKey: primary.item.key,
      currentKey: next.item.key,
      lastQueuedKey: next === primary ? rotation!.lastQueuedKey : next.item.key,
      until: next.previewUntil,
    };
    this.toolRotation = slice;
    if (this.callbacks.afterShow) {
      const generation = this.generation;
      afterShow.push(() =>
        this.callbacks.afterShow?.(() => {
          if (
            this.disposed ||
            this.generation !== generation ||
            this.toolRotation !== slice ||
            this.entries.get(next.item.key) !== next ||
            next.phase !== 'visible'
          )
            return;
          slice.until = Date.now() + TOOL_ROTATION_MS;
          next.previewUntil = slice.until;
          this.advance(Date.now(), false);
        })
      );
    }
    return slice.until;
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
        const lastContentIndex = this.scheduled.findLastIndex(
          ({ item }) => item.kind === 'instant' || (item.kind === 'text' && item.text.trim() !== '')
        );
        let activitySlots = 0;
        // Settle the previous group before admitting content or another queued tool. Count exiting
        // cards too: their slot stays occupied until the animation actually removes them.
        for (const [index, entry] of this.scheduled.entries()) {
          const { item } = entry;
          if (item.kind !== 'activity') continue;
          if (item.running && entry.phase === 'exiting') {
            entry.phase = 'visible';
            entry.exitGeneration += 1;
          }
          if (
            entry.phase !== 'grouped' &&
            (item.expanded ||
              (!item.active && item.running) ||
              (this.immediate && (!item.running || !this.keepRunningVisible)) ||
              (entry.phase === 'paused' && !item.running) ||
              (!item.animateExit &&
                entry.phase === 'visible' &&
                !item.running &&
                !this.inspectedActivities.has(item.key) &&
                now >= activityPreviewDeadline(entry, now)) ||
              (index < lastContentIndex &&
                !item.running &&
                !this.inspectedActivities.has(item.key)))
          ) {
            directlyGrouped.add(item.key);
            entry.phase = 'grouped';
          }
          if (entry.phase === 'exiting' && now >= entry.exitDeadline) entry.phase = 'grouped';
        }
        const hasLongerActivity = this.scheduled.some(
          ({ item, phase }) =>
            phase !== 'grouped' &&
            item.kind === 'activity' &&
            (item.running ||
              (item.durationMs !== undefined && item.durationMs >= SHORT_ACTIVITY_MS))
        );
        for (const entry of this.scheduled) {
          const { item } = entry;
          if (item.kind !== 'activity') continue;
          if (
            hasLongerActivity &&
            entry.phase === 'delayed' &&
            !item.running &&
            item.durationMs !== undefined &&
            item.durationMs < SHORT_ACTIVITY_MS &&
            !this.inspectedActivities.has(item.key)
          ) {
            directlyGrouped.add(item.key);
            entry.phase = 'grouped';
          }
        }
        const rotationAt = this.advanceToolRotation(now, directlyGrouped, afterShow);
        for (const entry of this.scheduled) {
          if (entry.phase === 'visible' || entry.phase === 'exiting') activitySlots += 1;
        }
        let blocked = false;
        let blockingBurst: Burst | null = null;
        let pending = false;
        let nextAt = rotationAt;
        for (const [index, entry] of this.scheduled.entries()) {
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
              entry.phase === 'delayed' &&
              activitySlots < MAX_VISIBLE_ACTIVITY
            ) {
              entry.phase = 'visible';
              activitySlots += 1;
              entry.visibleAt = now;
              if (entry.burst) entry.burst.visibleAt ??= now;
            }
            if (entry.phase === 'delayed' || entry.phase === 'paused') {
              const admissionAt = Math.max(
                entry.showAt,
                entry.queuedActivity
                  ? Math.max(
                      entry.burst?.nextAdmissionAt ?? 0,
                      entry.burst?.pendingPaintKey ? entry.burst.paintDeadline : 0
                    )
                  : 0
              );
              if (
                !wait &&
                activitySlots < MAX_VISIBLE_ACTIVITY &&
                entry.burst &&
                now >= admissionAt
              ) {
                const burst = entry.burst;
                const firstInBurst = burst.visibleAt === null;
                entry.phase = 'visible';
                activitySlots += 1;
                entry.previewUntil = null;
                entry.visibleAt = now;
                burst.visibleAt ??= now;
                // Hydrated tools can already exceed the threshold before their first admission.
                nextAt = Math.min(
                  nextAt,
                  this.advanceToolRotation(now, directlyGrouped, afterShow)
                );
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
                if (!wait && activitySlots < MAX_VISIBLE_ACTIVITY)
                  nextAt = Math.min(nextAt, Math.max(now + 1, admissionAt));
              }
            }
            if (entry.phase === 'visible') {
              const visibleUntil = activityPreviewDeadline(entry, now);
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
                (entry.phase === 'visible' && now < activityPreviewDeadline(entry, now)));
            const blocksContent = needsMoment && index > lastContentIndex;
            if (blocksContent && !blocked) blockingBurst = entry.burst;
            blocked ||= blocksContent;
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
        const previousPreviews = new Set([...this.visibleActivity(), ...this.retainedActivity()]);
        if (previousPreviews.size > 0) {
          for (const key of [...visible, ...retained]) {
            if (!previousPreviews.has(key)) this.callbacks.beforeReplaceActivity?.(key);
          }
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
        this.scheduled = this.scheduled.filter(
          (entry) => entry.item.kind !== 'activity' || entry.phase !== 'grouped'
        );
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
