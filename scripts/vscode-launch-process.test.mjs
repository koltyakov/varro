import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  reserveLoopbackPort,
  waitForVscodeProcess,
  writeVscodeLaunchMetadata,
} from './vscode-launch-process.mjs';

test('writes atomic launch metadata for the tracked process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vscode-launch-test-'));
  const metadataPath = path.join(root, 'launch.json');

  try {
    const metadata = await writeVscodeLaunchMetadata(metadataPath, {
      pid: process.pid,
      executable: process.execPath,
      profileRoot: root,
      userDataDir: path.join(root, 'u'),
      extensionsDir: path.join(root, 'e'),
      workspace: process.cwd(),
      remoteDebuggingPort: 9222,
    });
    const saved = JSON.parse(await readFile(metadataPath, 'utf8'));

    assert.equal(saved.pid, process.pid);
    assert.equal(saved.executable, process.execPath);
    assert.equal(saved.userDataDir, path.join(root, 'u'));
    assert.equal(saved.remoteDebuggingPort, 9222);
    assert.match(saved.birthIdentity, new RegExp(`^${process.platform}:`));
    assert.deepEqual(saved, metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reserves an available loopback port', async () => {
  const port = await reserveLoopbackPort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0, true);
});

test('does not match an unrelated process profile', async () => {
  await assert.rejects(
    waitForVscodeProcess(process.execPath, '/tmp/varro-profile-that-does-not-exist', 1),
    /Could not find the VS Code process/
  );
});
