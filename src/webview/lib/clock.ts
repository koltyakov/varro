import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';

// One shared ticker keeps every elapsed-time label on the same beat and runs
// only while some component still needs it.
class SharedClock {
  private readonly time = createSignal(Date.now());
  private subscribers = 0;
  private handle: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly interval: number) {}

  use(enabled: Accessor<boolean>): Accessor<number> {
    createEffect(() => {
      if (!enabled()) return;
      this.subscribers += 1;
      if (this.handle === undefined) {
        this.time[1](Date.now());
        this.handle = setInterval(() => this.time[1](Date.now()), this.interval);
      }
      onCleanup(() => {
        this.subscribers -= 1;
        if (this.subscribers === 0) {
          clearInterval(this.handle);
          this.handle = undefined;
        }
      });
    });
    return this.time[0];
  }
}

const secondClock = new SharedClock(1_000);
const minuteClock = new SharedClock(60_000);

export function useMinuteClock(enabled: Accessor<boolean> = () => true): Accessor<number> {
  return minuteClock.use(enabled);
}

/** Current time, refreshed about once per second while `enabled()` is true. */
export function useSecondClock(enabled: Accessor<boolean> = () => true): Accessor<number> {
  return secondClock.use(enabled);
}
