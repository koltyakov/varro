const RESIZE_SETTLE_MS = 100;

const callbacks = new WeakMap<Element, () => void>();
const observedElements = new Set<Element>();
const pendingElements = new Set<Element>();
let observer: ResizeObserver | null = null;
let settleTimer: ReturnType<typeof setTimeout> | 0 = 0;

function flushPendingElements() {
  settleTimer = 0;
  const pending = [...pendingElements];
  pendingElements.clear();
  for (const element of pending) callbacks.get(element)?.();
}

function getObserver() {
  if (observer || typeof ResizeObserver === 'undefined') return observer;
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (callbacks.has(entry.target)) pendingElements.add(entry.target);
    }
    if (pendingElements.size === 0) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(flushPendingElements, RESIZE_SETTLE_MS);
  });
  return observer;
}

export function observeSettledResize(element: Element, callback: () => void) {
  callbacks.set(element, callback);
  observedElements.add(element);
  getObserver()?.observe(element);

  return () => {
    callbacks.delete(element);
    pendingElements.delete(element);
    observedElements.delete(element);
    observer?.unobserve?.(element);
    if (observedElements.size > 0) return;

    observer?.disconnect();
    observer = null;
    pendingElements.clear();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = 0;
  };
}
