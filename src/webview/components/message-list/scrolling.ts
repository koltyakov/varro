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

export function getDistanceFromBottom(container: HTMLElement | null | undefined) {
  if (!container) return Number.POSITIVE_INFINITY;

  return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
}

export function performScrollToBottom(args: {
  container: HTMLElement | null | undefined;
  now: number;
  programmaticScrollWindowMs: number;
}) {
  const { container } = args;
  if (!container) return null;

  const nextScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  if (Math.abs(container.scrollTop - nextScrollTop) >= 1) {
    container.scrollTop = nextScrollTop;
  }
  return {
    nextScrollTop,
    nextIgnoreScrollUntil: args.now + args.programmaticScrollWindowMs,
  };
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
  const intentionalUserBreak =
    delta < -1 && (args.userScrolledUp || args.distanceFromBottom >= args.autoScrollThresholdPx);
  const nextFollowModeLocked = args.followModeLocked && !intentionalUserBreak;
  const userMovedAwayNearBottom =
    args.autoScroll &&
    delta < -1 &&
    args.distanceFromBottom > 1 &&
    (args.userScrolledUp || (args.bottomTargetStable && !nextFollowModeLocked));
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
      (args.expectedScrollTop !== -1 &&
        args.top < args.expectedScrollTop - args.autoScrollThresholdPx &&
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

  if (args.autoScroll && (delta >= 0 || nextFollowModeLocked)) {
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
