/* oxlint-disable anti-slop/no-module-mocking -- Only the editor API is substituted; process launch, ownership, HTTP, and credential recovery are real. */
import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import { OpenCodeServer } from './server';
import { OpenCodeTransport } from './open-code-transport';
import { diagnosticTimeline } from './diagnostics';

const editor = vi.hoisted(() => ({ directory: '' }));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const prompts = vi.hoisted(() => ({ warning: vi.fn() }));
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
    showWarningMessage: prompts.warning,
  },
}));

describe.skipIf(!process.env.VARRO_OPENCODE_TEST_BINARY)('released managed startup', () => {
  it.for(['configured', 'shadowed-discovery', 'service-replacement'] as const)(
    'starts, authenticates a second window, restarts, and stops its own isolated server using %s',
    { timeout: 60000 },
    async (mode, context) => {
      if (
        mode === 'shadowed-discovery' &&
        (process.platform === 'win32' || !process.env.VARRO_OPENCODE_TEST_VERSION?.startsWith('2.'))
      )
        context.skip();
      if (
        mode === 'service-replacement' &&
        !process.env.VARRO_OPENCODE_TEST_VERSION?.startsWith('2.')
      )
        context.skip();
      const binary = process.env.VARRO_OPENCODE_TEST_BINARY!;
      diagnosticTimeline.clear();
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
      vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'varro-test-state'));
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
      const leasePath = join(root, `varro-opencode-server-${address.port}.json`);
      let server = new OpenCodeServer(address.port, true, command, false, undefined, leasePath);
      let attached: OpenCodeServer | undefined;
      let replacement: ChildProcess | undefined;
      let phase = 'initial startup';
      const healthObservations: Array<{
        phase: string;
        healthy: boolean;
        error?: string;
        durationMs: number;
      }> = [];
      const readHealth = OpenCodeTransport.prototype.readHealthInfo;
      const healthObservation = vi
        .spyOn(OpenCodeTransport.prototype, 'readHealthInfo')
        .mockImplementation(async function (this: OpenCodeTransport, signal?: AbortSignal) {
          const started = performance.now();
          const result = await readHealth.call(this, signal);
          healthObservations.push({
            phase,
            healthy: result.healthy,
            error: this.healthError,
            durationMs: performance.now() - started,
          });
          return result;
        });
      context.onTestFailed(async () => {
        await writeFile(join(root, 'startup-diagnostics.md'), diagnosticTimeline.export(''));
        await writeFile(
          join(root, 'startup-log.json'),
          JSON.stringify(
            {
              info: logs.info.mock.calls,
              warn: logs.warn.mock.calls,
              error: logs.error.mock.calls,
            },
            null,
            2
          )
        );
        await writeFile(
          join(root, 'failure-status.json'),
          JSON.stringify({ mode, phase, serverStatus: server.status, healthObservations }, null, 2)
        );
      });
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
        phase = 'second-window attachment';
        expect(await attached.start()).toBe(url);
        const attachedInfo = await attached.readServerInfo();
        expect(attachedInfo.health.healthy).toBe(true);
        expect(attachedInfo.cliVersion).toBe(info.cliVersion);
        expect(attachedInfo.cliVersion).toBeTruthy();
        expect(attachedInfo.cliVersionError).toBeNull();
        expect(attached.isAttachOnly).toBe(true);
        await attached.dispose();
        attached = undefined;
        if (mode === 'service-replacement') {
          const password = lease?.password;
          if (!isString(password)) throw new Error('No fixture credential');
          await server.dispose();
          // An older disconnected editor can leave its retired registration
          // after the CLI replaces the service. Preserve that evidence verbatim.
          await writeFile(leasePath, JSON.stringify(lease), { mode: 0o600 });
          await writeFile(`${leasePath}.managed`, JSON.stringify(lease), { mode: 0o600 });
          // This scenario verifies registration recovery without replacing the
          // recovered listener. A configured Ask agent avoids runtime-config
          // repair choosing a new automatic port outside the verified test URL.
          await writeFile(
            join(editor.directory, 'opencode.json'),
            JSON.stringify({
              agents: { ask: { mode: 'primary', system: 'Fixture Ask agent' } },
            })
          );
          const replacementPort = await new Promise<number>((done, reject) => {
            listener.listen(0, '127.0.0.1', () => {
              const next = listener.address();
              if (!next || isString(next) || next.port < 49152)
                reject(new Error('No random fixture port'));
              else done(next.port);
            });
          });
          await new Promise<void>((done) => listener.close(() => done()));
          const replacementUrl = `http://127.0.0.1:${replacementPort}`;
          vi.stubEnv('VARRO_TEST_SERVER_URL', replacementUrl);
          replacement = spawn(binary, ['serve', '--service', '--port', String(replacementPort)], {
            cwd: editor.directory,
            env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
            stdio: 'ignore',
          });
          const deadline = Date.now() + 10000;
          const healthPath = info.health.version === '2.0.5' ? '/api/status' : '/api/info';
          let ready = false;
          while (Date.now() < deadline) {
            const response = await fetch(`${replacementUrl}${healthPath}`, {
              headers: {
                Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
              },
              signal: AbortSignal.timeout(1000),
            }).catch(() => null);
            if (response) {
              ready = response.ok;
              await response.body?.cancel();
            }
            if (ready) break;
            await new Promise<void>((done) => setTimeout(done, 100));
          }
          expect(ready).toBe(true);
          attached = new OpenCodeServer(
            'auto',
            true,
            binary,
            false,
            undefined,
            join(root, 'varro-opencode-server-4096.json')
          );
          phase = 'replacement recovery';
          expect(await attached.start()).toBe(replacementUrl);
          const replacementInfo = await attached.readServerInfo();
          expect(replacementInfo.ownership).toBe('current-host');
          expect(replacementInfo.managedProcess).toBe(true);
          expect(attached.isAttachOnly).toBe(false);
          const recovered = asRecord(JSON.parse(await readFile(leasePath, 'utf8')));
          expect(recovered?.pid).toBe(replacement.pid);
          expect(recovered?.port).toBe(replacementPort);
          expect(recovered?.password).toBe(password);
          expect(recovered?.owner).not.toBe(lease?.owner);
          expect(recovered?.configPath).toBeUndefined();
          await attached.disconnect();
          attached = new OpenCodeServer('auto', true, binary, false, undefined, leasePath);
          phase = 'recovered replacement reuse';
          expect(await attached.start()).toBe(replacementUrl);
          expect((await attached.readServerInfo()).ownership).toBe('current-host');
          return;
        }
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
            join(root, 'varro-opencode-server-4096.json')
          );
          expect(await attached.start()).toBe(url);
          const sharedInfo = await attached.readServerInfo();
          expect(sharedInfo.managedProcess).toBe(false);
          expect(sharedInfo.ownership).toBe('other-host');
          expect(attached.isAttachOnly).toBe(false);
          expect(asRecord(JSON.parse(await readFile(leasePath, 'utf8')))?.host).toBe(lease?.host);
          await attached.dispose();
          attached = undefined;
        }
        await server.disconnect();
        phase = 'inherited attachment';
        const inheritedLease = await readFile(leasePath, 'utf8');
        attached = new OpenCodeServer('auto', false, binary, false, undefined, leasePath);
        expect(await attached.start()).toBe(url);
        expect(await readFile(leasePath, 'utf8')).toBe(inheritedLease);
        expect((await attached.readServerInfo()).health.healthy).toBe(true);
        await attached.disconnect();
        attached = undefined;
        server = new OpenCodeServer(address.port, true, binary, false, undefined, leasePath);
        phase = 'managed restart';
        expect(await server.start()).toBe(url);
        expect(await server.restart()).toBe(url);
        expect((await server.readServerInfo()).health.healthy).toBe(true);
      } catch (error) {
        await writeFile(
          join(root, 'failure.json'),
          JSON.stringify(
            {
              mode,
              phase,
              message: error instanceof Error ? error.message : String(error),
              serverStatus: server.status,
              attachedStatus: attached?.status,
            },
            null,
            2
          )
        );
        throw new Error(`Isolated ${mode} failed during ${phase}; evidence: ${root}`, {
          cause: error,
        });
      } finally {
        healthObservation.mockRestore();
        await attached?.dispose();
        await server.dispose();
        if (replacement && replacement.exitCode === null && replacement.signalCode === null) {
          const exited = new Promise<void>((done) => replacement!.once('exit', () => done()));
          replacement.kill();
          await exited;
        }
        vi.unstubAllEnvs();
        await writeFile(join(root, 'startup-diagnostics.md'), diagnosticTimeline.export(''));
      }
    }
  );
});

describe.skipIf(!process.env.VARRO_OPENCODE_TEST_BINARY)('released multi-window recovery', () => {
  it(
    'reattaches a second window after the shared server is killed or restarted, without consent prompts',
    { timeout: 90000 },
    async () => {
      const binary = process.env.VARRO_OPENCODE_TEST_BINARY!;
      diagnosticTimeline.clear();
      prompts.warning.mockClear();
      const parent = resolve('artifacts/ai-test-data');
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, 'multi-window-'));
      for (const directory of ['home', 'data', 'state', 'cache', 'config', 'workspace'])
        await mkdir(join(root, directory));
      editor.directory = join(root, 'workspace');
      expect(spawnSync('git', ['init', '--quiet'], { cwd: editor.directory }).status).toBe(0);
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
      vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'varro-test-state'));
      const leasePath = join(root, `varro-opencode-server-${address.port}.json`);
      const readLease = async (): Promise<{ pid: number; host: string }> => {
        const lease = asRecord(JSON.parse(await readFile(leasePath, 'utf8')));
        if (!isNumber(lease?.pid) || !isString(lease.host))
          throw new Error('Invalid fixture lease');
        return { pid: lease.pid, host: lease.host };
      };
      const owner = new OpenCodeServer(address.port, true, binary, false, undefined, leasePath);
      const follower = new OpenCodeServer(address.port, true, binary, false, undefined, leasePath);
      let phase = 'initial attachment';
      const timeline: Array<{ phase: string; window: string; state: string; at: number }> = [];
      const started = performance.now();
      owner.on('status', (status: { state: string }) =>
        timeline.push({
          phase,
          window: 'owner',
          state: status.state,
          at: performance.now() - started,
        })
      );
      follower.on('status', (status: { state: string }) =>
        timeline.push({
          phase,
          window: 'follower',
          state: status.state,
          at: performance.now() - started,
        })
      );
      const waitForReplacement = async (previousPid: number) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const lease = await readLease().catch(() => null);
          if (
            lease &&
            lease.pid !== previousPid &&
            owner.status.state === 'running' &&
            follower.status.state === 'running' &&
            follower.status.eventStream === 'healthy'
          )
            return lease;
          await new Promise<void>((done) => setTimeout(done, 100));
        }
        throw new Error(`No quiet reattachment during ${phase}`);
      };
      try {
        expect(await owner.start()).toBe(url);
        expect(await follower.start()).toBe(url);
        expect((await follower.readServerInfo()).ownership).toBe('other-host');
        const original = await readLease();

        phase = 'killed owned server';
        process.kill(original.pid, 'SIGKILL');
        const replaced = await waitForReplacement(original.pid);
        // The owner relaunches first; the follower reuses its new registration.
        expect(replaced.host).toBe(original.host);
        expect((await owner.readServerInfo()).managedProcess).toBe(true);
        const followerInfo = await follower.readServerInfo();
        expect(followerInfo.health.healthy).toBe(true);
        expect(followerInfo.ownership).toBe('other-host');

        phase = 'owner restart';
        expect(await owner.restart()).toBe(url);
        const restarted = await waitForReplacement(replaced.pid);
        expect((await follower.readServerInfo()).health.healthy).toBe(true);

        phase = 'killed server without a live owner';
        await owner.disconnect();
        process.kill(restarted.pid, 'SIGKILL');
        const deadline = Date.now() + 30000;
        let relaunched: { pid: number; host: string } | null = null;
        while (Date.now() < deadline) {
          relaunched = await readLease().catch(() => null);
          if (
            relaunched &&
            relaunched.pid !== restarted.pid &&
            follower.status.state === 'running' &&
            follower.status.eventStream === 'healthy'
          )
            break;
          await new Promise<void>((done) => setTimeout(done, 100));
        }
        expect(relaunched?.pid).not.toBe(restarted.pid);
        const adopted = await follower.readServerInfo();
        expect(adopted.health.healthy).toBe(true);
        expect(adopted.managedProcess).toBe(true);
        expect(prompts.warning).not.toHaveBeenCalled();
      } catch (error) {
        await writeFile(
          join(root, 'failure.json'),
          JSON.stringify(
            {
              phase,
              message: error instanceof Error ? error.message : String(error),
              ownerStatus: owner.status,
              followerStatus: follower.status,
              prompts: prompts.warning.mock.calls,
              timeline,
              warnings: logs.warn.mock.calls,
            },
            null,
            2
          )
        );
        throw new Error(
          `Isolated multi-window recovery failed during ${phase}; evidence: ${root}`,
          {
            cause: error,
          }
        );
      } finally {
        await writeFile(join(root, 'timeline.json'), JSON.stringify(timeline, null, 2));
        await follower.dispose();
        await owner.dispose();
        vi.unstubAllEnvs();
      }
    }
  );
});
