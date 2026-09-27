import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('..', import.meta.url));

test('E2E startup avoids an occupied default port and preserves explicit and playback ports', async (t) => {
  const occupied = createServer();
  try {
    occupied.listen(4174, '127.0.0.1');
    await once(occupied, 'listening');
    t.after(
      () =>
        new Promise((resolve, reject) =>
          occupied.close((error) => (error ? reject(error) : resolve()))
        )
    );
  } catch (error) {
    // An existing development server also reproduces the collision.
    if (error.code !== 'EADDRINUSE') throw error;
  }

  for (const mode of ['', 'raster', 'playback']) {
    for (const explicitPort of [undefined, '4174']) {
      const env = {
        ...process.env,
        VARRO_E2E_MODE: mode,
        VARRO_PLAYBACK_ID: '92',
        VARRO_PLAYBACK_FILE: 'nonexistent-playback-capture.json',
      };
      delete env.VARRO_E2E_PORT;
      if (explicitPort !== undefined) env.VARRO_E2E_PORT = explicitPort;
      const { stdout, stderr } = await exec(
        process.execPath,
        ['scripts/run-e2e.mjs', '--list', '--reporter=json'],
        { cwd, env, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
      );
      const report = JSON.parse(stdout);
      const server = [report.config.webServer].flat()[0];
      const baseURL = new URL(server.url).origin;
      assert.equal(server.url, `${baseURL}/e2e/harness/index.html`);
      assert.equal(server.reuseExistingServer, mode === 'playback');
      if (explicitPort !== undefined || mode === 'playback') {
        assert.equal(baseURL, 'http://127.0.0.1:4174');
        assert.doesNotMatch(stderr, /is occupied/);
      } else {
        assert.notEqual(new URL(baseURL).port, '4174');
        assert.match(server.command, new RegExp(`--port ${new URL(baseURL).port} --strictPort$`));
        assert.match(stderr, /E2E port 4174 is occupied; using \d+\./);
      }
      assert.ok(report.suites.length > 0);
    }
  }
});
