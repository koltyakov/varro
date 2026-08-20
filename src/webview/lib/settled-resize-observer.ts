const RESIZE_SETTLE_MS = 100;

const callbacks = new WeakMap<Element, () => void>();
const observedElements = new Set<Element>();
const settleTimers = new Map<Element, ReturnType<typeof setTimeout>>();
let observer: ResizeObserver | null = null;

function scheduleSettledCallback(element: Element) {
  const existingTimer = settleTimers.get(element);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  settleTimers.set(
    element,
    setTimeout(() => {
      settleTimers.delete(element);
      callbacks.get(element)?.();
    }, RESIZE_SETTLE_MS)
  );
}

function getObserver() {
  if (observer || globalThis.ResizeObserver === undefined) return observer;
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (callbacks.has(entry.target)) scheduleSettledCallback(entry.target);
    }
  });
  return observer;
}

export function observeSettledResize(element: Element, callback: () => void) {
  callbacks.set(element, callback);
  observedElements.add(element);
  getObserver()?.observe(element);

  return () => {
    callbacks.delete(element);
    const settleTimer = settleTimers.get(element);
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimers.delete(element);
    observedElements.delete(element);
    observer?.unobserve?.(element);
    if (observedElements.size > 0) return;

    observer?.disconnect();
    observer = null;
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
  };
}
