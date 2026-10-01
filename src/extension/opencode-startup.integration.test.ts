/* oxlint-disable anti-slop/no-module-mocking -- Only the editor API is substituted; process launch, ownership, HTTP, and credential recovery are real. */
import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { asRecord, isString } from '../shared/type-utils';
import { OpenCodeServer } from './server';

const editor = vi.hoisted(() => ({ directory: '' }));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('./logger', () => ({ logger: logs }));
vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: editor.directory } }];
    },
    getConfiguration: () => ({
      get: <T>(key: string, fallback?: T) => (key === 'server.autoUpdate' ? false : fallback),
    }),
  },
  window: {
    activeTextEditor: undefined,
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

describe.skipIf(!process.env.VARRO_OPENCODE_TEST_BINARY)('released managed startup', () => {
  it.for(['configured', 'shadowed-discovery'] as const)(
    'starts, authenticates a second window, restarts, and stops its own isolated server using %s',
    { timeout: 60000 },
    async (mode, context) => {
      if (
        mode === 'shadowed-discovery' &&
        (process.platform === 'win32' || !process.env.VARRO_OPENCODE_TEST_VERSION?.startsWith('2.'))
      )
        context.skip();
      const binary = process.env.VARRO_OPENCODE_TEST_BINARY!;
      const parent = resolve('artifacts/ai-test-data');
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, 'startup-'));
      for (const directory of ['home', 'data', 'state', 'cache', 'config', 'workspace'])
        await mkdir(join(root, directory));
      editor.directory = join(root, 'workspace');
      const git = spawnSync('git', ['init', '--quiet'], { cwd: editor.directory });
      expect(git.status).toBe(0);
      await writeFile(
        join(editor.directory, 'opencode.json'),
        JSON.stringify({ enabled_providers: [] })
      );
      const listener = createServer();
      await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
      const address = listener.address();
      if (!address || isString(address)) throw new Error('No fixture port');
      await new Promise<void>((done) => listener.close(() => done()));
      const url = `http://127.0.0.1:${address.port}`;
      for (const key of Object.keys(process.env)) {
        if (/^OPENCODE_|_API_KEY$|_TOKEN$|^AWS_|^AZURE_|^GOOGLE_|^ANTHROPIC_/.test(key))
          vi.stubEnv(key, undefined);
      }
      vi.stubEnv('HOME', join(root, 'home'));
      vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
      vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
      vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
      vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
      vi.stubEnv('OPENCODE_DB', join(root, 'data/test.db'));
      vi.stubEnv('OPENCODE_TEST_HOME', join(root, 'home'));
      vi.stubEnv('VARRO_TEST_SERVER_URL', url);
      let command = binary;
      let discoveredCommand: string | undefined;
      if (mode === 'shadowed-discovery') {
        const early = join(root, 'early');
        const later = join(root, 'later');
        await mkdir(early);
        await mkdir(later);
        const wrapper = join(early, 'opencode2');
        await writeFile(wrapper, '#!/bin/sh\nprintf "1.18.34\\n"\n');
        await chmod(wrapper, 0o755);
        discoveredCommand = join(later, 'opencode2');
        await symlink(binary, discoveredCommand);
        vi.stubEnv('PATH', [early, later, process.env.PATH].join(delimiter));
        command = '';
      }
      const leasePath = join(root, 'lease.json');
      let server = new OpenCodeServer(address.port, true, command, false, undefined, leasePath);
      let attached: OpenCodeServer | undefined;
      try {
        expect(await server.start()).toBe(url);
        const info = await server.readServerInfo();
        expect(info.health.healthy).toBe(true);
        expect(info.managedProcess).toBe(true);
        if (discoveredCommand) expect(info.resolvedCommand).toBe(discoveredCommand);
        if (process.env.VARRO_OPENCODE_TEST_VERSION)
          expect(info.health.version).toBe(process.env.VARRO_OPENCODE_TEST_VERSION);
        const lease = asRecord(JSON.parse(await readFile(leasePath, 'utf8')));
        expect(lease?.password).toBeTruthy();
        const anonymous = await fetch(
          `${url}${info.health.version?.startsWith('2.') ? '/api/session?limit=1' : '/session'}`
        );
        expect(anonymous.status).toBe(401);
        await anonymous.body?.cancel();
        if (info.health.version?.startsWith('2.')) {
          const registrationPath = join(root, 'state/opencode/service.json');
          const registration = await readFile(registrationPath, 'utf8');
          expect(asRecord(JSON.parse(registration))?.url).toBe(url);
          const cli = spawnSync(binary, ['api', 'get', '/api/session?limit=1'], {
            cwd: editor.directory,
            encoding: 'utf8',
            timeout: 10000,
          });
          expect(cli.status, cli.stderr).toBe(0);
          expect(await readFile(registrationPath, 'utf8')).toBe(registration);
          expect(lease?.password).toBeTruthy();
          const output = JSON.stringify([
            logs.info.mock.calls,
            logs.warn.mock.calls,
            logs.error.mock.calls,
          ]);
          expect(output).not.toContain(String(lease?.password));
        }
        attached = new OpenCodeServer(address.port, false, binary, false, undefined, leasePath);
        expect(await attached.start()).toBe(url);
        expect((await attached.readServerInfo()).health.healthy).toBe(true);
        await attached.dispose();
        attached = undefined;
        if (info.health.version?.startsWith('2.')) {
          await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
          const otherAddress = listener.address();
          if (!otherAddress || isString(otherAddress)) throw new Error('No second fixture port');
          await new Promise<void>((done) => listener.close(() => done()));
          attached = new OpenCodeServer(
            'auto',
            true,
            binary,
            false,
            undefined,
            join(root, 'other-lease.json')
          );
          expect(await attached.start()).toBe(url);
          expect((await attached.readServerInfo()).managedProcess).toBe(false);
          await attached.dispose();
          attached = undefined;
        }
        await server.disconnect();
        const inheritedLease = await readFile(leasePath, 'utf8');
        attached = new OpenCodeServer('auto', false, binary, false, undefined, leasePath);
        expect(await attached.start()).toBe(url);
        expect(await readFile(leasePath, 'utf8')).toBe(inheritedLease);
        expect((await attached.readServerInfo()).health.healthy).toBe(true);
        await attached.disconnect();
        attached = undefined;
        server = new OpenCodeServer(address.port, true, binary, false, undefined, leasePath);
        expect(await server.start()).toBe(url);
        expect(await server.restart()).toBe(url);
        expect((await server.readServerInfo()).health.healthy).toBe(true);
      } finally {
        await attached?.dispose();
        await server.dispose();
        vi.unstubAllEnvs();
      }
    }
  );
});
