import { createSignal } from 'solid-js';

/**
 * Tracks whether Alt is held. Window listeners are installed while at least one
 * consumer retains the tracker and removed, with the state reset, on the last release.
 */
export function createAltKeyTracker() {
  const [pressed, setPressed] = createSignal(false);
  let listenerCount = 0;

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Alt') setPressed(true);
  };
  const handleKeyup = (event: KeyboardEvent) => {
    if (event.key === 'Alt') setPressed(false);
  };
  const handleMousemove = (event: MouseEvent) => setPressed(event.altKey);
  const handleBlur = () => setPressed(false);

  const retain = () => {
    if (listenerCount === 0) {
      window.addEventListener('keydown', handleKeydown);
      window.addEventListener('keyup', handleKeyup);
      window.addEventListener('mousemove', handleMousemove);
      window.addEventListener('blur', handleBlur);
    }
    listenerCount += 1;

    return () => {
      listenerCount -= 1;
      if (listenerCount > 0) return;
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('keyup', handleKeyup);
      window.removeEventListener('mousemove', handleMousemove);
      window.removeEventListener('blur', handleBlur);
      setPressed(false);
    };
  };

  return { pressed, retain };
}
