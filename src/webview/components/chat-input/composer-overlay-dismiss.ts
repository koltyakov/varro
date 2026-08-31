const dismissListeners = new Set<() => void>();

export function dismissComposerOverlays() {
  for (const listener of Array.from(dismissListeners)) listener();
}

export function registerComposerOverlayDismiss(listener: () => void): () => void {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}
