import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';

const SECOND_CLOCK_INTERVAL_MS = 1_000;

// One shared ticker keeps every elapsed-time label on the same beat and runs
// only while some component still needs it.
const [secondClockNow, setSecondClockNow] = createSignal(Date.now());
let secondClockSubscribers = 0;
let secondClockHandle: ReturnType<typeof setInterval> | null = null;

function acquireSecondClock(): () => void {
  secondClockSubscribers += 1;
  if (secondClockHandle === null) {
    // The last tick may be from long ago, so start from the current time.
    setSecondClockNow(Date.now());
    secondClockHandle = setInterval(() => setSecondClockNow(Date.now()), SECOND_CLOCK_INTERVAL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    secondClockSubscribers -= 1;
    if (secondClockSubscribers <= 0 && secondClockHandle !== null) {
      clearInterval(secondClockHandle);
      secondClockHandle = null;
      secondClockSubscribers = 0;
    }
  };
}

/** Current time, refreshed about once per second while `enabled()` is true. */
export function useSecondClock(enabled: Accessor<boolean> = () => true): Accessor<number> {
  createEffect(() => {
    if (enabled()) onCleanup(acquireSecondClock());
  });
  return secondClockNow;
}
