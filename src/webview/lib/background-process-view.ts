import { createSignal } from 'solid-js';

type BackgroundProcessView = { sessionID: string; directory?: string; processID?: string };

const [backgroundProcessView, setBackgroundProcessView] =
  createSignal<BackgroundProcessView | null>(null);

export { backgroundProcessView };

export function openBackgroundProcessView(
  sessionID: string,
  directory?: string,
  processID?: string
) {
  setBackgroundProcessView({ sessionID, directory, processID });
}

export function closeBackgroundProcessView() {
  setBackgroundProcessView(null);
}
