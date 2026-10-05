// @ts-check
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

/** Copy the selected CC0 water-bubble recording without changing its sound. */
export function buildNotificationSound(directory) {
  copyFileSync(
    new URL('../assets/notifications/water-bubble.wav', import.meta.url),
    join(directory, 'notification.wav')
  );
}
