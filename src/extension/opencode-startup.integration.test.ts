/* oxlint-disable anti-slop/no-module-mocking -- The editor API is substituted and ownership-unavailable injects lifecycle inspection failure; process launch, HTTP, and credential persistence remain real. */
import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import { OpenCodeServer } from './server';
import { OpenCodeProcess } from './open-code-process';
import { OpenCodeTransport } from './open-code-transport';
import { diagnosticTimeline } from './diagnostics';
import { findListeningPids, inspectLocalServerAccount } from './process-inspection';
import { getVarroStateDirectory } from './varro-state-paths';

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
  it.for([
    'configured',
    'shadowed-discovery',
    'service-replacement',
    'editor-reload',
    'marker-reload',
    'reboot-reconnect',
    'ownership-unavailable',
    'credential-port-replacement',
    'desktop-service',
  ] as const)(
    'starts, authenticates a second window, restarts, and stops its own isolated server using %s',
    { timeout: 60000 },
    async (mode, context) => {
      if (
        mode === 'shadowed-discovery' &&
        (process.platform === 'win32' || !process.env.VARRO_OPENCODE_TEST_VERSION?.startsWith('2.'))
      )
        context.skip();
      if (
        (mode === 'service-replacement' ||
          mode === 'marker-reload' ||
          mode === 'credential-port-replacement' ||
          mode === 'desktop-service') &&
        !process.env.VARRO_OPENCODE_TEST_VERSION?.startsWith('2.')
      )
        context.skip();
      const binary = process.env.VARRO_OPENCODE_TEST_BINARY!;
      diagnosticTimeline.clear();
      prompts.warning.mockClear();
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
      let server = new OpenCodeServer(address.port, true, command, false, leasePath);
      let attached: OpenCodeServer | undefined;
      let replacement: ChildProcess | undefined;
      let unownedLaunch: ChildProcess | undefined;
      let unownedListener: number | undefined;
      const desktopBinary = process.env.VARRO_OPENCODE_DESKTOP_TEST_BINARY || binary;
      let desktopStarted = false;
      let desktopRegistration: string | undefined;
      const credentialLaunch =
        mode === 'ownership-unavailable' || mode === 'credential-port-replacement';
      const ownershipFailure = credentialLaunch
        ? vi
            .spyOn(OpenCodeProcess.prototype, 'confirmManagedServerOwnership')
            .mockResolvedValue(false)
        : undefined;
      const launchServer = OpenCodeProcess.prototype.launchServer;
      const launchObservation = credentialLaunch
        ? vi.spyOn(OpenCodeProcess.prototype, 'launchServer').mockImplementation(function (
            this: OpenCodeProcess,
            options
          ) {
            const child = launchServer.call(this, options);
            unownedLaunch = child;
            return child;
          })
        : undefined;
      let phase = 'initial startup';
      const probes: Array<{
        phase: string;
        route: string;
        authenticated: boolean;
        status: number;
        contentType: string | null;
      }> = [];
      const realFetch = globalThis.fetch;
      const fetchObservation = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, options) => {
          const response = await realFetch(input, options);
          const target = input instanceof Request ? input.url : String(input);
          if (target.startsWith(url))
            probes.push({
              phase,
              route: new URL(target).pathname,
              authenticated: new Headers(options?.headers).has('Authorization'),
              status: response.status,
              contentType: response.headers.get('content-type'),
            });
          return response;
        });
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
        expect(info.managedProcess).toBe(!credentialLaunch);
        if (discoveredCommand) expect(info.resolvedCommand).toBe(discoveredCommand);
        if (process.env.VARRO_OPENCODE_TEST_VERSION)
          expect(info.health.version).toBe(process.env.VARRO_OPENCODE_TEST_VERSION);
        const recordPath = credentialLaunch ? `${leasePath}.credentials` : leasePath;
        const initialRecord = await readFile(recordPath, 'utf8');
        const lease = asRecord(JSON.parse(initialRecord));
        const initialListeners = await findListeningPids(address.port);
        expect(initialListeners).toHaveLength(1);
        if (credentialLaunch) unownedListener = initialListeners[0];
        expect(lease?.password).toBeTruthy();
        const anonymous = await fetch(
          `${url}${info.health.version?.startsWith('2.') ? '/api/session?limit=1' : '/session'}`
        );
        expect(anonymous.status).toBe(401);
        await anonymous.body?.cancel();
        if (info.health.version?.startsWith('2.')) {
          const serviceStateHome = join(getVarroStateDirectory('servers'), 'opencode-service');
          const registrationPath = join(serviceStateHome, 'opencode/service.json');
          const registration = await readFile(registrationPath, 'utf8');
          expect(asRecord(JSON.parse(registration))?.url).toBe(url);
          await expect(readFile(join(root, 'state/opencode/service.json'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const cli = spawnSync(binary, ['api', 'get', '/api/session?limit=1'], {
            cwd: editor.directory,
            env: { ...process.env, XDG_STATE_HOME: serviceStateHome },
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
        if (mode === 'desktop-service') {
          phase = 'Desktop background service startup';
          desktopStarted = true;
          await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
          const desktopAddress = listener.address();
          if (!desktopAddress || isString(desktopAddress))
            throw new Error('No Desktop fixture port');
          await new Promise<void>((done) => listener.close(() => done()));
          // Do not contend with a production service on OpenCode's default port.
          const configured = spawnSync(
            desktopBinary,
            ['service', 'set', 'port', String(desktopAddress.port)],
            { cwd: editor.directory, encoding: 'utf8', timeout: 15000 }
          );
          expect(configured.status, configured.stderr).toBe(0);
          // Desktop runs these service commands using its own bundled CLI. Both
          // processes use only this fixture's database, config, and state roots.
          const desktop = spawnSync(desktopBinary, ['service', 'start'], {
            cwd: editor.directory,
            encoding: 'utf8',
            timeout: 30000,
          });
          expect(desktop.status, desktop.stderr).toBe(0);
          desktopRegistration = await readFile(join(root, 'state/opencode/service.json'), 'utf8');
          const desktopInfo = asRecord(JSON.parse(desktopRegistration));
          expect(desktopInfo?.url).not.toBe(url);
          expect(desktopInfo?.pid).not.toBe(initialListeners[0]);
          expect(await findListeningPids(address.port)).toEqual(initialListeners);
          expect((await server.readServerInfo()).health.healthy).toBe(true);
          expect(await readFile(recordPath, 'utf8')).toBe(initialRecord);
          await writeFile(
            join(root, 'desktop-service-result.json'),
            JSON.stringify(
              {
                varroVersion: info.health.version,
                desktopVersion: desktopInfo?.version,
                varroPid: initialListeners[0],
                desktopPid: desktopInfo?.pid,
                varroUrl: url,
                desktopUrl: desktopInfo?.url,
              },
              null,
              2
            )
          );
        }
        attached = new OpenCodeServer(address.port, false, binary, false, leasePath);
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
        if (
          mode === 'editor-reload' ||
          mode === 'marker-reload' ||
          mode === 'reboot-reconnect' ||
          mode === 'ownership-unavailable'
        ) {
          const session = asRecord(
            await server.request('POST', '/session', { title: 'Reconnect fixture' })
          );
          if (!isString(session?.id)) throw new Error('No fixture session');
          if (mode === 'reboot-reconnect') {
            // Simulate the persisted pre-reboot record while replacing only this
            // isolated fixture's process. Keep the exact port, password, and database.
            phase = 'simulated reboot';
            if (!isNumber(lease?.pid) || !isString(lease.password))
              throw new Error('No isolated fixture process or credential');
            expect(await findListeningPids(address.port)).toEqual([lease.pid]);
            // SAFETY: The isolated host owns this fixture process. A real reboot
            // also ends the old host, so its exit-cleanup callback cannot run.
            // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The fixture needs its private launch handle to simulate loss of the old host.
            const { processManager } = server as unknown as { processManager: OpenCodeProcess };
            const launched = processManager.process;
            if (!launched) throw new Error('No isolated launch handle');
            await server.disconnect();
            launched.removeAllListeners('exit');
            const exited = new Promise<void>((done) => launched.once('exit', () => done()));
            process.kill(lease.pid, 'SIGKILL');
            if (launched.pid !== lease.pid) launched.kill('SIGKILL');
            await exited;
            const route = info.health.version?.startsWith('2.') ? '/api/info' : '/global/health';
            const stopDeadline = Date.now() + 10000;
            let stopped = false;
            while (!stopped && Date.now() < stopDeadline) {
              const response = await fetch(`${url}${route}`, {
                headers: {
                  Authorization: `Basic ${Buffer.from(`opencode:${lease.password}`).toString('base64')}`,
                },
                signal: AbortSignal.timeout(500),
              }).catch(() => null);
              stopped = response === null;
              await response?.body?.cancel();
              if (!stopped) await new Promise<void>((done) => setTimeout(done, 50));
            }
            expect(stopped).toBe(true);
            await writeFile(leasePath, JSON.stringify(lease), { mode: 0o600 });
            await writeFile(`${leasePath}.managed`, JSON.stringify(lease), { mode: 0o600 });
            replacement = spawn(
              binary,
              [
                'serve',
                ...(info.health.version?.startsWith('2.') ? ['--service'] : []),
                '--port',
                String(address.port),
              ],
              {
                cwd: editor.directory,
                env: { ...process.env, OPENCODE_SERVER_PASSWORD: String(lease?.password) },
                stdio: 'ignore',
              }
            );
            const deadline = Date.now() + 10000;
            let ready = false;
            while (!ready && Date.now() < deadline) {
              const response = await fetch(`${url}${route}`, {
                headers: {
                  Authorization: `Basic ${Buffer.from(`opencode:${lease?.password}`).toString('base64')}`,
                },
                signal: AbortSignal.timeout(1000),
              }).catch(() => null);
              if (response) {
                ready = response.ok;
                await response.body?.cancel();
              }
              if (!ready) await new Promise<void>((done) => setTimeout(done, 50));
            }
            expect(ready).toBe(true);
          } else await server.disconnect();
          if (mode === 'marker-reload') await rm(leasePath);
          const reconnects: Array<{
            reload: number;
            account: string;
            pid: number;
            eventStream: string;
          }> = [];
          for (let reload = 0; reload < 3; reload += 1) {
            phase = `${mode} ${reload + 1}`;
            // Automatic mode must reuse the persisted record. V2 also discovers
            // records under another fixed-port key through its service endpoint.
            attached = new OpenCodeServer(
              'auto',
              true,
              binary,
              false,
              info.health.version?.startsWith('2.')
                ? join(root, 'varro-opencode-server-4096.json')
                : leasePath
            );
            expect(await attached.start()).toBe(url);
            const reconnected = await attached.readServerInfo();
            expect(reconnected.health.healthy).toBe(true);
            expect(reconnected.ownership).toBe(
              mode === 'reboot-reconnect' || mode === 'ownership-unavailable'
                ? 'unmanaged'
                : 'current-host'
            );
            expect(attached.isAttachOnly).toBe(
              mode === 'reboot-reconnect' || mode === 'ownership-unavailable'
            );
            const current = asRecord(JSON.parse(await readFile(recordPath, 'utf8')));
            expect(current?.pid).toBe(lease?.pid);
            expect(current?.password === lease?.password).toBe(true);
            const listeners = await findListeningPids(address.port);
            expect(listeners).toHaveLength(1);
            if (mode === 'reboot-reconnect') expect(listeners[0]).not.toBe(lease?.pid);
            else expect(listeners[0]).toBe(initialListeners[0]);
            const sessions = await attached.request('GET', '/session');
            if (!Array.isArray(sessions)) throw new Error('No reconnected session catalog');
            expect(sessions.some((value) => asRecord(value)?.id === session.id)).toBe(true);
            const deadline = Date.now() + 5000;
            while (
              attached.status.state === 'running' &&
              attached.status.eventStream !== 'healthy' &&
              Date.now() < deadline
            )
              await new Promise<void>((done) => setTimeout(done, 50));
            expect(attached.status).toMatchObject({ state: 'running', eventStream: 'healthy' });
            const account = await inspectLocalServerAccount(address.port);
            if (process.env.VARRO_TEST_EXPECT_ACCOUNT)
              expect(account.kind).toBe(process.env.VARRO_TEST_EXPECT_ACCOUNT);
            reconnects.push({
              reload: reload + 1,
              account: account.kind,
              pid: listeners[0]!,
              eventStream: 'healthy',
            });
            expect(prompts.warning).not.toHaveBeenCalled();
            await attached.disconnect();
          }
          await writeFile(
            join(root, 'reconnect-result.json'),
            JSON.stringify(
              {
                mode,
                platform: process.platform,
                version: info.health.version,
                prompts: prompts.warning.mock.calls.length,
                reconnects,
              },
              null,
              2
            )
          );
          return;
        }
        if (mode === 'service-replacement' || mode === 'credential-port-replacement') {
          const password = lease?.password;
          if (!isString(password)) throw new Error('No fixture credential');
          await server.dispose();
          if (credentialLaunch && unownedListener && unownedLaunch) {
            unownedLaunch.removeAllListeners('exit');
            const stopped = new Promise<void>((done) => unownedLaunch!.once('exit', () => done()));
            process.kill(unownedListener, 'SIGKILL');
            if (unownedLaunch.pid !== unownedListener) unownedLaunch.kill('SIGKILL');
            await stopped;
            unownedListener = undefined;
            unownedLaunch = undefined;
          }
          // An older disconnected editor can leave its retired registration
          // after the CLI replaces the service. Preserve that evidence verbatim.
          if (!credentialLaunch) {
            await writeFile(leasePath, JSON.stringify(lease), { mode: 0o600 });
            await writeFile(`${leasePath}.managed`, JSON.stringify(lease), { mode: 0o600 });
          }
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
              if (!next || isString(next) || (!credentialLaunch && next.port < 49152))
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
            join(root, 'varro-opencode-server-4096.json')
          );
          phase = 'replacement recovery';
          expect(await attached.start()).toBe(replacementUrl);
          const replacementInfo = await attached.readServerInfo();
          expect(replacementInfo.ownership).toBe(credentialLaunch ? 'unmanaged' : 'current-host');
          expect(replacementInfo.managedProcess).toBe(!credentialLaunch);
          expect(attached.isAttachOnly).toBe(credentialLaunch);
          const recovered = asRecord(JSON.parse(await readFile(recordPath, 'utf8')));
          expect(recovered?.pid).toBe(credentialLaunch ? undefined : replacement.pid);
          expect(recovered?.port).toBe(credentialLaunch ? address.port : replacementPort);
          expect(recovered?.password).toBe(password);
          if (credentialLaunch) expect(recovered?.owner).toBe(lease?.owner);
          else expect(recovered?.owner).not.toBe(lease?.owner);
          expect(recovered?.configPath).toBeUndefined();
          await attached.disconnect();
          attached = new OpenCodeServer('auto', true, binary, false, leasePath);
          phase = 'recovered replacement reuse';
          expect(await attached.start()).toBe(replacementUrl);
          expect((await attached.readServerInfo()).ownership).toBe(
            credentialLaunch ? 'unmanaged' : 'current-host'
          );
          expect(prompts.warning).not.toHaveBeenCalled();
          if (credentialLaunch) {
            await expect(attached.restart()).rejects.toThrow('attach-only');
            expect(await findListeningPids(replacementPort)).toHaveLength(1);
          }
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
        attached = new OpenCodeServer('auto', false, binary, false, leasePath);
        expect(await attached.start()).toBe(url);
        expect(await readFile(leasePath, 'utf8')).toBe(inheritedLease);
        expect((await attached.readServerInfo()).health.healthy).toBe(true);
        await attached.disconnect();
        attached = undefined;
        server = new OpenCodeServer(address.port, true, binary, false, leasePath);
        phase = 'managed restart';
        expect(await server.start()).toBe(url);
        expect(await server.restart()).toBe(url);
        expect((await server.readServerInfo()).health.healthy).toBe(true);
        if (desktopRegistration)
          expect(await readFile(join(root, 'state/opencode/service.json'), 'utf8')).toBe(
            desktopRegistration
          );
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
        fetchObservation.mockRestore();
        await writeFile(join(root, 'connection-probes.json'), JSON.stringify(probes, null, 2));
        healthObservation.mockRestore();
        await attached?.dispose();
        await server.dispose();
        if (desktopStarted) {
          const stopped = spawnSync(desktopBinary, ['service', 'stop'], {
            cwd: editor.directory,
            encoding: 'utf8',
            timeout: 15000,
          });
          expect(stopped.status, stopped.stderr).toBe(0);
        }
        ownershipFailure?.mockRestore();
        launchObservation?.mockRestore();
        if (unownedListener) {
          // The test owns this isolated launch even though the simulated editor
          // cannot prove lifecycle ownership. Teardown never targets production.
          unownedLaunch?.removeAllListeners('exit');
          process.kill(unownedListener, 'SIGKILL');
          if (unownedLaunch?.pid !== unownedListener) unownedLaunch?.kill('SIGKILL');
        }
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
      const owner = new OpenCodeServer(address.port, true, binary, false, leasePath);
      const follower = new OpenCodeServer(address.port, true, binary, false, leasePath);
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
