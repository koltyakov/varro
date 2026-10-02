// @ts-check
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { listProjectFiles, TestCache } from './test-cache.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {{
 *   root: string,
 *   args: string[],
 *   environment: NodeJS.ProcessEnv,
 *   browserVersion: () => Promise<string>,
 *   run: () => Promise<void>,
 * }} options
 */
export async function runCachedE2e(options) {
  const { root, args, environment, browserVersion, run } = options;
  // Filters, shards, list-only runs, and diagnostic/playback modes cannot prove a full-suite pass.
  if (args.length > 0 || environment.VARRO_E2E_MODE) {
    process.stdout.write('[test-cache] e2e: bypassing cache for arguments or a custom mode\n');
    await run();
    return;
  }

  const relevantEnvironment = Object.fromEntries(
    Object.entries(environment)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .filter(([key]) =>
        /^(?:VARRO_|OPENCODE_|PLAYWRIGHT_|VITE_|NODE_OPTIONS$|NODE_ENV$|CI$|TZ$|LANG$|LC_)/.test(
          key
        )
      )
  );
  const context = JSON.stringify([
    'e2e',
    process.platform,
    process.arch,
    release(),
    process.version,
    availableParallelism(),
    await browserVersion(),
    // Environment values can contain credentials. Persist only their hash.
    createHash('sha256').update(JSON.stringify(relevantEnvironment)).digest('hex'),
  ]);
  const files = listProjectFiles(root);
  const cache = new TestCache(root, path.join(root, 'tmp/test-cache/e2e.json'), files, context);
  await cache.load();
  // Vite reads these even when they are ignored by Git.
  const fingerprint = await cache.hashFiles([
    ...files,
    ...cache.globalFiles,
    '.env',
    '.env.local',
    '.env.e2e',
    '.env.e2e.local',
  ]);
  if (cache.entries.e2e === fingerprint) {
    process.stdout.write('[test-cache] e2e: reused successful full-suite result\n');
    return;
  }

  // An interrupted or failing run must not leave a reusable success behind.
  cache.entries = {};
  await cache.save();
  process.stdout.write('[test-cache] e2e: running full suite\n');
  await run();
  cache.entries.e2e = fingerprint;
  await cache.save();
}

async function main() {
  const args = process.argv.slice(2);
  await runCachedE2e({
    root: projectRoot,
    args,
    environment: process.env,
    browserVersion: async () => {
      // Check the actual headless browser, not just the lockfile or full Chromium executable.
      const browser = await chromium.launch();
      try {
        return browser.version();
      } finally {
        await browser.close();
      }
    },
    run: () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/run-e2e.mjs', ...args], {
          cwd: projectRoot,
          stdio: 'inherit',
          shell: false,
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                signal
                  ? `E2E process exited with ${signal}`
                  : `E2E process exited with code ${String(code)}`
              )
            );
        });
      }),
  });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
