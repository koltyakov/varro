export type ExpansionScrollAnchor = {
  element: HTMLElement;
  top: number;
  expiresAt: number;
};

export type AutoScrollDecision = {
  nextAutoScroll: boolean | null;
  nextExpectedScrollTop: number;
  nextIgnoreScrollUntil: number;
  nextLastObservedScrollTop: number;
  nextFollowModeLocked: boolean;
  shouldCancelPendingScroll: boolean;
};

export function recoverScrollAnchorDescendant(args: {
  renderItem: HTMLElement;
  elementTag: string;
  elementOrdinal?: number;
  elementText?: string;
}) {
  const matches = Array.from(
    args.renderItem.querySelectorAll<HTMLElement>(args.elementTag.toLowerCase())
  );
  const ordinalMatch = args.elementOrdinal === undefined ? undefined : matches[args.elementOrdinal];
  if (ordinalMatch) return ordinalMatch;
  return matches.find(
    (element) =>
      (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) === args.elementText
  );
}

export function getDistanceFromBottom(container: HTMLElement | null | undefined) {
  if (!container) return Number.POSITIVE_INFINITY;

  return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
}

export function performScrollToBottom(args: {
  container: HTMLElement | null | undefined;
  now: number;
  programmaticScrollWindowMs: number;
  elapsedMs?: number;
  motion?: BottomFollowMotion;
}) {
  const { container } = args;
  if (!container) return null;

  const target = Math.max(0, container.scrollHeight - container.clientHeight);
  if (args.elapsedMs === undefined) args.motion?.reset();
  const nextScrollTop =
    args.motion && args.elapsedMs !== undefined
      ? args.motion.next(container.scrollTop, target, args.elapsedMs)
      : target;
  if (Math.abs(container.scrollTop - nextScrollTop) >= 1) {
    container.scrollTop = nextScrollTop;
  }
  return {
    nextScrollTop,
    nextIgnoreScrollUntil: args.now + args.programmaticScrollWindowMs,
  };
}

export class BottomFollowMotion {
  private position: number | null = null;
  private velocity = 0;

  reset(): void {
    this.position = null;
    this.velocity = 0;
  }

  next(top: number, target: number, elapsedMs: number): number {
    // Keep fractional progress when Chromium rounds scrollTop, but discard momentum
    // when another scroll owner moves the viewport.
    if (this.position === null || Math.abs(top - this.position) > 1.5) {
      this.position = top;
      this.velocity = 0;
    }
    const distance = target - this.position;
    if (distance <= 2) {
      this.reset();
      return target;
    }

    // Critically damped motion starts gently and retains velocity across new targets.
    // Limit the spring's distance so a tall new block cannot cause a high-speed surge.
    const smoothTimeMs = 220;
    const maxSpeedPxPerMs = 1.1;
    const elapsed = Math.min(32, Math.max(1, elapsedMs));
    const omega = 2 / smoothTimeMs;
    const offset = -Math.min(distance, maxSpeedPxPerMs * smoothTimeMs);
    const destination = this.position - offset;
    const decay = Math.exp(-omega * elapsed);
    const change = (this.velocity + omega * offset) * elapsed;
    this.velocity = (this.velocity - omega * change) * decay;
    this.position = Math.max(top, Math.min(target, destination + (offset + change) * decay));
    if (target - this.position <= 1) {
      this.reset();
      return target;
    }
    return this.position;
  }
}

export function getSmoothBottomFollowTop(top: number, target: number, elapsedMs: number): number {
  const distance = target - top;
  // The follow loop settles within one pixel; finish before a minimum one-pixel step
  // would leave a fractional remainder that the loop no longer corrects.
  if (distance <= 2) return target;
  const fraction = 1 - Math.exp(-Math.min(64, Math.max(1, elapsedMs)) / 55);
  return Math.min(target, top + Math.max(1, distance * fraction));
}

export function captureExpansionScrollAnchor(args: {
  anchor: HTMLElement;
  container: HTMLElement;
  now: number;
  windowMs: number;
}): ExpansionScrollAnchor {
  const containerRect = args.container.getBoundingClientRect();
  return {
    element: args.anchor,
    top: args.anchor.getBoundingClientRect().top - containerRect.top,
    expiresAt: args.now + args.windowMs,
  };
}

export function restoreExpansionScrollAnchor(args: {
  anchor: ExpansionScrollAnchor | null;
  container: HTMLElement | null | undefined;
  now: number;
  programmaticScrollWindowMs: number;
}) {
  const { anchor, container } = args;
  if (!anchor || !container) return null;
  if (args.now > anchor.expiresAt || !anchor.element.isConnected) return null;

  const containerRect = container.getBoundingClientRect();
  const nextTop = anchor.element.getBoundingClientRect().top - containerRect.top;
  const delta = nextTop - anchor.top;
  const nextScrollTop = Math.max(0, container.scrollTop + delta);

  if (Math.abs(delta) >= 1) {
    container.scrollTop = nextScrollTop;
  }

  return {
    nextScrollTop,
    nextIgnoreScrollUntil: args.now + args.programmaticScrollWindowMs,
  };
}

export function resolveAutoScrollOnUserScroll(args: {
  top: number;
  distanceFromBottom: number;
  nearBottom: boolean;
  autoScroll: boolean;
  userScrolledUp: boolean;
  bottomTargetStable: boolean;
  followModeLocked: boolean;
  expectedScrollTop: number;
  lastObservedScrollTop: number;
  ignoreScrollUntil: number;
  now: number;
  autoScrollThresholdPx: number;
}): AutoScrollDecision {
  const delta = args.top - args.lastObservedScrollTop;
  const intentionalUserBreak = delta < -0.5 && args.userScrolledUp;
  const nextFollowModeLocked = args.followModeLocked && !intentionalUserBreak;
  const userMovedAwayNearBottom =
    args.autoScroll && delta < -0.5 && args.distanceFromBottom > 1 && args.userScrolledUp;
  const userMovedAwayFromExpectedTarget =
    args.expectedScrollTop !== -1 &&
    args.userScrolledUp &&
    args.top < args.expectedScrollTop - args.autoScrollThresholdPx * 2 &&
    !nextFollowModeLocked;
  const matchesExpected =
    args.expectedScrollTop !== -1 &&
    (Math.abs(args.top - args.expectedScrollTop) < 2 ||
      (args.nearBottom &&
        args.top >= args.expectedScrollTop - args.autoScrollThresholdPx &&
        !userMovedAwayNearBottom));

  if (matchesExpected) {
    return {
      nextAutoScroll: null,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: args.ignoreScrollUntil,
      nextLastObservedScrollTop: args.top,
      nextFollowModeLocked,
      shouldCancelPendingScroll: false,
    };
  }

  if (args.now <= args.ignoreScrollUntil) {
    const userMovedAwayFromTarget =
      intentionalUserBreak ||
      userMovedAwayNearBottom ||
      userMovedAwayFromExpectedTarget ||
      (args.expectedScrollTop !== -1 &&
        args.top < args.expectedScrollTop - args.autoScrollThresholdPx &&
        args.userScrolledUp &&
        !nextFollowModeLocked);

    if (!userMovedAwayFromTarget) {
      return {
        nextAutoScroll: null,
        nextExpectedScrollTop: args.expectedScrollTop,
        nextIgnoreScrollUntil: args.ignoreScrollUntil,
        nextLastObservedScrollTop: args.top,
        nextFollowModeLocked,
        shouldCancelPendingScroll: false,
      };
    }

    return {
      nextAutoScroll: false,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: 0,
      nextLastObservedScrollTop: args.top,
      nextFollowModeLocked: false,
      shouldCancelPendingScroll: true,
    };
  }

  if (args.nearBottom) {
    if (intentionalUserBreak || userMovedAwayNearBottom) {
      return {
        nextAutoScroll: false,
        nextExpectedScrollTop: -1,
        nextIgnoreScrollUntil: args.ignoreScrollUntil,
        nextLastObservedScrollTop: args.top,
        nextFollowModeLocked: false,
        shouldCancelPendingScroll: true,
      };
    }

    return {
      nextAutoScroll: true,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: args.ignoreScrollUntil,
      nextLastObservedScrollTop: args.top,
      nextFollowModeLocked,
      shouldCancelPendingScroll: false,
    };
  }

  if (args.autoScroll && !intentionalUserBreak) {
    return {
      nextAutoScroll: null,
      nextExpectedScrollTop: -1,
      nextIgnoreScrollUntil: args.ignoreScrollUntil,
      nextLastObservedScrollTop: args.top,
      nextFollowModeLocked,
      shouldCancelPendingScroll: false,
    };
  }

  return {
    nextAutoScroll: false,
    nextExpectedScrollTop: -1,
    nextIgnoreScrollUntil: args.ignoreScrollUntil,
    nextLastObservedScrollTop: args.top,
    nextFollowModeLocked: false,
    shouldCancelPendingScroll: true,
  };
}
