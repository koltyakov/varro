// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let directory = '';
let executable = '';

before(async () => {
  if (process.platform !== 'darwin') return;
  directory = await mkdtemp(join(tmpdir(), 'varro-notification-response-'));
  executable = join(directory, 'response-test');
  await run(
    '/usr/bin/xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-framework',
      'Cocoa',
      '-framework',
      'CoreGraphics',
      '-framework',
      'UserNotifications',
      '-mmacosx-version-min=11.0',
      join(root, 'native/macos-notifications/response.test.m'),
      '-o',
      executable,
    ],
    { timeout: 30_000 }
  );
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const url = 'vscode://file/Users/test/Project%20%231/Project.code-workspace';
for (const scenario of [
  {
    name: 'opens the encoded project URI before acknowledging the click',
    action: 'default',
    url,
    result: 'success',
    events: ['open', 'complete'],
    code: 0,
  },
  {
    name: 'acknowledges an open failure and reports it',
    action: 'default',
    url,
    result: 'failure',
    events: ['open', 'complete'],
    code: 6,
  },
  {
    name: 'does not open a project on dismissal',
    action: 'dismiss',
    url,
    result: 'success',
    events: ['complete'],
    code: 0,
  },
  {
    name: 'handles older notifications without a URL',
    action: 'default',
    url: '',
    result: 'success',
    events: ['complete'],
    code: 0,
  },
  {
    name: 'supports already-delivered chat links',
    action: 'default',
    url: 'vscode://koltyakov.varro/notification?session%3Dses_test%26windowId%3D42',
    result: 'success',
    events: ['open', 'complete'],
    code: 0,
  },
  {
    name: 'rejects a non-editor protocol',
    action: 'default',
    url: 'https://file/Users/test/project',
    result: 'success',
    events: ['complete'],
    code: 0,
  },
  {
    name: 'rejects project links with action parameters',
    action: 'default',
    url: 'vscode://file/Users/test/project?session=other',
    result: 'success',
    events: ['complete'],
    code: 0,
  },
  {
    name: 'rejects a URL for a different extension',
    action: 'default',
    url: 'vscode://other.extension/notification',
    result: 'success',
    events: ['complete'],
    code: 0,
  },
]) {
  test(scenario.name, { skip: process.platform !== 'darwin' }, async () => {
    // The test process replaces NSWorkspace.openURL, so these checks open no application windows.
    const result = await new Promise((accept, reject) => {
      execFile(
        executable,
        [scenario.action, scenario.url, scenario.result],
        { timeout: 5000 },
        (error, stdout) => {
          if (error && error.code !== scenario.code) reject(error);
          else accept(JSON.parse(stdout));
        }
      );
    });
    assert.deepEqual(result, {
      events: scenario.events,
      url: scenario.events.includes('open') ? scenario.url : '',
      exitCode: scenario.code,
    });
  });
}
