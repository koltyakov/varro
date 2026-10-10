import { createSignal } from 'solid-js';

type BackgroundProcessView = { sessionID: string; directory?: string };

const [backgroundProcessView, setBackgroundProcessView] =
  createSignal<BackgroundProcessView | null>(null);

export { backgroundProcessView };

export function openBackgroundProcessView(sessionID: string, directory?: string) {
  setBackgroundProcessView({ sessionID, directory });
}

export function closeBackgroundProcessView() {
  setBackgroundProcessView(null);
}
