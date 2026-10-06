import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { thumbnailWorkerBuildOptions } from '../../scripts/build-thumbnail-worker.mjs';
import { SharedThumbnailClient } from './image-thumbnail-shared-client';

const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let directory: string;
let servicePath: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'varro-shared-thumbnail-'));
  await build(thumbnailWorkerBuildOptions(directory));
  servicePath = join(directory, 'thumbnail-service.js');
});
afterAll(async () => {
  await sleep(1800);
  await rm(directory, { recursive: true, force: true });
});

describe('cross-process thumbnail service', () => {
  it('never uploads images to a replacement listener without a valid same-connection proof', async () => {
    const stateDirectory = join(directory, 'identity-account');
    const client = new SharedThumbnailClient({ servicePath, stateDirectory, idleMs: 200 });
    await client.convert(gif, 'gif', new AbortController().signal);
    await sleep(500);
    const identity = createHash('sha256')
      .update(stateDirectory)
      .update(servicePath)
      .update(await readFile(servicePath))
      .update(await readFile(join(directory, 'thumbnail-worker.js')))
      .digest();
    const port = 40000 + (identity.readUInt32LE(0) % 20000);
    let uploaded = 0;
    let posts = 0;
    const impostor = createServer();
    impostor.on('checkContinue', (request, response) => {
      posts++;
      request.on('data', (chunk: Buffer) => {
        uploaded += chunk.length;
      });
      response.writeContinue();
    });
    await new Promise<void>((resolve, reject) => {
      impostor.once('error', reject);
      impostor.listen(port, '127.0.0.1', resolve);
    });
    try {
      await expect(client.convert(gif, 'gif', new AbortController().signal)).rejects.toThrow(
        'Invalid thumbnail service identity'
      );
      expect(posts).toBe(1);
      expect(uploaded).toBe(0);
    } finally {
      client.dispose();
      impostor.closeAllConnections();
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  });

  it('arbitrates concurrent starts from independent extension hosts and survives their exits', async () => {
    const stateDirectory = join(directory, 'shared-account');
    const options = { servicePath, stateDirectory, idleMs: 1500 };
    const script = `
      const { SharedThumbnailClient } = require(${JSON.stringify(servicePath)});
      const client = new SharedThumbnailClient(${JSON.stringify(options)});
      client.convert(${JSON.stringify(gif)}, 'gif', new AbortController().signal).then(url => {
        console.log(JSON.stringify({ pid: client.processID, ownPID: process.pid, url }));
        client.dispose();
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const outputs = await Promise.all(
      Array.from({ length: 3 }, () =>
        promisify(execFile)(process.execPath, ['-e', script], { timeout: 15_000 })
      )
    );
    // SAFETY: The child program above emits exactly this diagnostic JSON after real conversion.
    const results = outputs.map(
      ({ stdout }) => JSON.parse(stdout) as { pid: number; ownPID: number; url: string }
    );
    expect(new Set(results.map((result) => result.ownPID)).size).toBe(3);
    expect(new Set(results.map((result) => result.pid)).size).toBe(1);
    expect(
      results.every(
        (result) => result.pid !== result.ownPID && result.url.startsWith('data:image/webp;base64,')
      )
    ).toBe(true);
    const survivor = new SharedThumbnailClient(options);
    try {
      expect(await survivor.convert(gif, 'gif', new AbortController().signal)).toBe(
        results[0]!.url
      );
      expect(survivor.processID).toBe(results[0]!.pid);
      expect(await readdir(stateDirectory)).toEqual(['secret']);
      await sleep(1800);
      expect(await survivor.convert(gif, 'gif', new AbortController().signal)).toBe(
        results[0]!.url
      );
      expect(survivor.processID).not.toBe(results[0]!.pid);
    } finally {
      survivor.dispose();
    }
  }, 20_000);

  it('rejects excess inputs before admission and keeps clients independently cancellable', async () => {
    const options = {
      servicePath,
      stateDirectory: join(directory, 'cancel-account'),
      idleMs: 1500,
    };
    const first = new SharedThumbnailClient(options);
    const second = new SharedThumbnailClient(options);
    try {
      const controller = new AbortController();
      const cancelled = first.convert(gif, 'gif', controller.signal);
      const rejection = expect(cancelled).rejects.toThrow();
      controller.abort();
      await rejection;
      await expect(second.convert(gif, 'gif', new AbortController().signal)).resolves.toMatch(
        /^data:image\/webp/
      );
      first.dispose();
      await expect(second.convert(gif, 'gif', new AbortController().signal)).resolves.toMatch(
        /^data:image\/webp/
      );
      await expect(
        second.convert(
          'A'.repeat((24 * 1024 * 1024 * 4) / 3 + 4),
          'png',
          new AbortController().signal
        )
      ).resolves.toBeNull();
      await expect(second.convert('AAAA', 'png', new AbortController().signal)).resolves.toBeNull();
    } finally {
      first.dispose();
      second.dispose();
    }
  }, 20_000);
});
