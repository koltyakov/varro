import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { controlRequest, runCapture } from './ai-streaming.mjs';
import {
  ImageMagick,
  initializeImageMagick,
  MagickColors,
  MagickFormat,
} from '@imagemagick/magick-wasm';

// A real-editor infrastructure check with generated data. No provider or source database is used.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts/ai-streaming', `runner-smoke-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const sessionID = 'ses_runner_smoke';
const now = Date.now();
const require = createRequire(import.meta.url);
await initializeImageMagick(
  await readFile(require.resolve('@imagemagick/magick-wasm/magick.wasm'))
);
const images = [
  [MagickFormat.Png, 'png', MagickColors.Red],
  [MagickFormat.Jpeg, 'jpeg', MagickColors.Blue],
  [MagickFormat.Gif, 'gif', MagickColors.Green],
].map(([format, mime, color], index) => ({
  id: `prt_smoke_image_${index}`,
  messageID: 'msg_smoke_user',
  sessionID,
  type: 'file',
  mime: `image/${mime}`,
  filename: `replayed-${index}.${mime}`,
  url: ImageMagick.read(color, 1600, 900, (image) =>
    image.write(
      format,
      (data) => `data:image/${mime};base64,${Buffer.from(data).toString('base64')}`
    )
  ),
}));
const user = {
  info: {
    id: 'msg_smoke_user',
    sessionID,
    role: 'user',
    time: { created: now },
    agent: 'build',
    model: { providerID: 'replay', modelID: 'replay' },
  },
  parts: [
    {
      id: 'prt_smoke_user',
      messageID: 'msg_smoke_user',
      sessionID,
      type: 'text',
      text: 'Verify replay checkpoint delivery.',
    },
    ...images.slice(0, 2),
  ],
};
const info = {
  id: 'msg_smoke_assistant',
  sessionID,
  parentID: user.info.id,
  role: 'assistant',
  time: { created: now + 1 },
  agent: 'build',
  mode: 'build',
  modelID: 'replay',
  providerID: 'replay',
  path: { cwd: '/generated', root: '/generated' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const part = { id: 'prt_smoke_text', messageID: info.id, sessionID, type: 'text', text: '' };
const completed = { ...info, finish: 'stop', time: { ...info.time, completed: now + 500 } };
const text = 'CHECKPOINT-ONE\n\nCHECKPOINT-TWO';
const delta = (value) => ({
  type: 'message.part.delta',
  properties: { sessionID, messageID: info.id, partID: part.id, field: 'text', delta: value },
});
const capture = {
  scenario: 'RUNNER-SMOKE',
  session: {
    id: sessionID,
    projectID: 'generated',
    directory: '/generated',
    title: 'Replay runner smoke',
    version: '1',
    time: { created: now, updated: now },
  },
  initialMessages: [user, { info, parts: [part] }],
  finalMessages: [
    { ...user, parts: [...user.parts, images[2]] },
    { info: completed, parts: [{ ...part, text }] },
  ],
  events: [
    {
      offsetMs: 0,
      event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    },
    { offsetMs: 50, event: delta('CHECKPOINT-ONE\n\n') },
    { offsetMs: 150, event: delta('CHECKPOINT-TWO') },
    { offsetMs: 175, event: { type: 'message.part.updated', properties: { part: images[2] } } },
    { offsetMs: 200, event: { type: 'message.updated', properties: { info: completed } } },
    { offsetMs: 250, event: { type: 'session.idle', properties: { sessionID } } },
  ],
};
const capturePath = path.join(output, 'capture.json');
await writeFile(capturePath, JSON.stringify(capture), { mode: 0o600 });
const runDirectory = path.join(output, 'editor');
let finished = false;
const run = runCapture({
  capture: capturePath,
  output: runDirectory,
  checkpoints: [0, 2, 6],
  'start-timeout-ms': 30_000,
  'replay-timeout-ms': 60_000,
})
  .then(
    (result) => ({ result }),
    (error) => ({ error })
  )
  .finally(() => {
    finished = true;
  });
let control;
const waitFor = async (read, accept, label) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (finished)
      throw new Error(
        `Runner exited before ${label}: ${(await run).error?.message ?? 'completed'}`
      );
    const value = await Promise.resolve()
      .then(read)
      .catch(async (error) => {
        // The runner closes control before owned-host cleanup finishes on failure.
        // Preserve that failure and wait for cleanup instead of exiting mid-shutdown.
        const result = await run;
        throw result.error ?? error;
      });
    if (accept(value)) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
try {
  control = await waitFor(
    async () => {
      try {
        return JSON.parse(await readFile(path.join(runDirectory, 'control.json'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }
    },
    Boolean,
    'control descriptor'
  );
  await waitFor(
    () => controlRequest(control, 'status'),
    (state) => state.phase === 'armed',
    'armed editor'
  );
  await controlRequest(control, 'start');
  for (const count of [0, 2, 6]) {
    const state = await waitFor(
      () => controlRequest(control, 'status'),
      (value) => value.playbackState === 'paused',
      `checkpoint ${count}`
    );
    assert.equal(state.progress.appliedEvents, count);
    // Allow normal transport batching/painting to deliver events already emitted before the pause.
    await sleep(500);
    const snapshot = await controlRequest(control, 'snapshot');
    const evidence = JSON.parse(await readFile(snapshot.evidence.json, 'utf8'));
    assert.equal(evidence.route.route.sessionId, state.sessionID);
    const rendered = evidence.dom.rows.map((row) => row.text).join('\n');
    assert.equal(rendered.includes('CHECKPOINT-ONE'), count >= 2);
    assert.equal(rendered.includes('CHECKPOINT-TWO'), count >= 5);
    const thumbnails = evidence.dom.rows.flatMap((row) => row.images ?? []);
    assert.equal(thumbnails.length, count >= 6 ? 3 : 2);
    assert.ok(
      thumbnails.every(
        (image) =>
          image.complete &&
          image.naturalWidth === 384 &&
          image.naturalHeight === 216 &&
          image.sourcePrefix.startsWith('data:image/webp;base64,')
      ),
      'Replay images must use real bounded WASM thumbnails, including the live base64 attachment'
    );
    assert.ok((await readFile(snapshot.evidence.screenshot)).length > 100);
    await controlRequest(control, 'resume');
  }
  const { result, error } = await run;
  if (error) throw error;
  assert.deepEqual(result.cleanupErrors, []);
  assert.equal(result.hostCleanup.hostExited, true);
  assert.equal(result.hostCleanup.debugEndpointStopped, true);
  const server = JSON.parse(await readFile(path.join(runDirectory, 'server-result.json'), 'utf8'));
  assert.equal(server.canonicalMatch, true);
  assert.equal(server.scheduler.pauses.length, 3);
  process.stdout.write(
    `PASS: real VS Code checkpoint delivery, snapshots, canonical result, and host cleanup. Evidence: ${output}\n`
  );
  process.stdout.write(
    'Infrastructure smoke only. This does not award an AI visual or performance verdict.\n'
  );
} finally {
  if (!finished && control) {
    await controlRequest(control, 'stop').catch(() => {
      // Best effort: setup failure can already have closed the control listener.
    });
  }
  await run;
}
