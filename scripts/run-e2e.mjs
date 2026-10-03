// @ts-check
import { createServer } from 'node:net';
import { prepareShard } from './e2e-sharding.mjs';

/** @param {number} port @returns {Promise<number>} */
function availablePort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node can return a pipe name instead of a TCP address.
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not select an E2E server port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

// Playback can attach to an existing server; regular runs need their own server.
if (process.env.VARRO_E2E_PORT === undefined && process.env.VARRO_E2E_MODE !== 'playback') {
  let port;
  try {
    port = await availablePort(4174);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') {
      throw error;
    }
    port = await availablePort(0);
    process.stderr.write(`E2E port 4174 is occupied; using ${port}.\n`);
  }
  process.env.VARRO_E2E_PORT = String(port);
}

// Run in this process so Playwright retains control of signals and server cleanup.
process.argv.splice(
  2,
  process.argv.length - 2,
  'test',
  ...(await prepareShard(process.argv.slice(2)))
);
await import(import.meta.resolve('@playwright/test/cli'));
