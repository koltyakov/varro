import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from '@playwright/test';
import { verifySessionPlayback } from '../session-playback';
import type { PlaybackFixture } from '../session-playback';

test('recorded session playback has no frame-level flicker', async ({ page }) => {
  const playbackId = Number(process.env.VARRO_PLAYBACK_ID);
  const replayFile = process.env.VARRO_PLAYBACK_FILE;
  if (!Number.isInteger(playbackId) || playbackId < 1 || !replayFile) {
    throw new Error(
      'Local playback requires a capture. Run npm run ai:playback -- replay --id <capture-id>'
    );
  }
  let contents: string;
  try {
    contents = await readFile(path.resolve(replayFile), 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read playback ${String(playbackId)} from ${replayFile}. Run npm run ai:playback -- replay --id ${String(playbackId)} to regenerate it.`,
      { cause: error }
    );
  }
  // SAFETY: The replay CLI writes this private temporary file from a validated SQLite capture.
  const playback = JSON.parse(contents) as PlaybackFixture;
  await verifySessionPlayback(page, playback);
});
