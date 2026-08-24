import { onCleanup } from 'solid-js';

const COMPOSER_OVERLAY_DISMISS_EVENT = 'varro:composer-overlay-dismiss';

export function dismissComposerOverlays() {
  window.dispatchEvent(new Event(COMPOSER_OVERLAY_DISMISS_EVENT));
}

export function onComposerOverlayDismiss(listener: () => void) {
  window.addEventListener(COMPOSER_OVERLAY_DISMISS_EVENT, listener);
  onCleanup(() => window.removeEventListener(COMPOSER_OVERLAY_DISMISS_EVENT, listener));
}
