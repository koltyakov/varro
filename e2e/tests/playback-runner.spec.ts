import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import type { PlaybackFixture } from '../session-playback';

// Playback must reuse one server, and losing a development socket must not
// reload the document during evaluation.
test('recorded playback reuses the running harness without starting another server', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varro-playback-e2e-'));
  const fixture: PlaybackFixture = {
    capture: {
      id: 1,
      label: 'Playback runner regression',
      scenario: 'TEST',
      session: {
        id: 'session-runner-regression',
        projectID: 'project-regression',
        directory: '/workspace/varro',
        title: 'Playback runner regression',
        version: '1.0.0',
        time: { created: 1_780_000_000_000, updated: 1_780_000_000_000 },
      },
      initialMessages: [],
      finalMessages: [],
    },
    timeline: [],
  };
  const captureFile = path.join(directory, 'capture.json');
  try {
    await writeFile(captureFile, JSON.stringify(fixture));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        createRequire(path.join(process.cwd(), 'package.json')).resolve('@playwright/test/cli'),
        'test',
        '--output',
        path.join(directory, 'results'),
      ],
      {
        timeout: 50_000,
        env: {
          ...process.env,
          VARRO_E2E_MODE: 'playback',
          VARRO_PLAYBACK_ID: '1',
          VARRO_PLAYBACK_FILE: captureFile,
        },
      }
    );
    expect(stdout).toContain('1 passed');
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      throw new Error(`${error.message}\n${String(error.stdout)}\n${String(error.stderr)}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('E2E server socket loss cannot navigate an active playback document', async ({
  page,
}, testInfo) => {
  const server = await createServer({
    mode: 'e2e',
    // Do not let this server's dependency optimizer replace the running harness's cache.
    cacheDir: testInfo.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Missing E2E server address');
    await page.goto(new URL('e2e/harness/index.html?scenario=busy-stop-send', url).href);
    await expect(page.getByLabel('Chat messages', { exact: true })).toBeVisible();
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    const evaluation = page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return document.querySelector('[aria-label="Chat messages"]') !== null;
    });
    const result = expect(evaluation).resolves.toBe(true);
    for (const client of server.ws.clients) client.socket.close();
    await result;
    expect(navigations).toEqual([]);
    expect(server.ws.clients.size).toBe(0);
  } finally {
    await server.close();
  }
});
