// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MacOSTray, projectTraySessions } from './macos-tray';
import type { TrayProject, TraySession, TraySnapshot } from './macos-tray';
import type { PendingAttentionEntry } from './session-state-manager';

function row(status: TraySession['status'] = 'running', updatedAt = 0): TraySession {
  return {
    id: 'root',
    title: 'Fix tests',
    project: 'Repo',
    projectUrl: 'vscode://file/repo',
    status,
    updatedAt,
  };
}

function projection() {
  const readState: Record<string, number> = {};
  const state = {
    busy: new Set<string>(),
    completed: new Set<string>(),
    failed: new Set<string>(),
    pendingForUser: new Map<string, PendingAttentionEntry>(),
    rootSessionIdFor: (id: string) => (id === 'child' ? 'root' : id),
    directoryFor: () => '/repo',
    titleFor: (id: string) => (id === 'root' ? 'Root chat' : 'Child chat'),
    isPlanSession: () => false,
    completionMarkerFor: () => 123,
    failureMarkerFor: () => 124,
    busyStartedAtFor: vi.fn((_id: string): number | undefined => undefined),
  };
  return {
    state,
    serverIdentity: 'http://localhost:1234',
    readState,
    includes: vi.fn(() => true),
    projectFor: () => ({
      id: '/repo',
      name: 'Workspace',
      url: 'vscode://file/workspace.code-workspace',
    }),
  };
}

describe('tray session projection', () => {
  it('uses the root turn start even when a child started more recently', () => {
    const host = projection();
    host.state.busy.add('child');
    host.state.busy.add('root');
    host.state.busyStartedAtFor.mockImplementation((id) => (id === 'root' ? 100 : 200));
    expect(projectTraySessions(host)).toEqual([
      expect.objectContaining({ status: 'running', turnStartedAt: 100 }),
    ]);
    host.state.busyStartedAtFor.mockImplementation((id) => (id === 'child' ? 200 : undefined));
    expect(projectTraySessions(host)[0]?.turnStartedAt).toBe(200);
  });

  it('rolls child attention into the root and preserves its workspace window URL', () => {
    const host = projection();
    host.state.busy.add('root');
    host.state.pendingForUser.set('ask', {
      sessionID: 'child',
      kind: 'permission',
      label: 'Permission',
      props: {},
    });
    expect(projectTraySessions(host)).toEqual([
      expect.objectContaining({
        title: 'Root chat',
        status: 'permission',
        projectUrl: 'vscode://file/workspace.code-workspace',
      }),
    ]);
    host.state.pendingForUser.clear();
    expect(projectTraySessions(host)[0]?.status).toBe('running');
  });

  it('excludes hidden/out-of-window sessions and namespaces different servers', () => {
    const host = projection();
    host.state.busy.add('root');
    const first = projectTraySessions(host)[0]?.id;
    host.serverIdentity = 'http://localhost:5678';
    expect(projectTraySessions(host)[0]?.id).not.toBe(first);
    host.includes.mockReturnValue(false);
    expect(projectTraySessions(host)).toEqual([]);
  });

  it('uses completion markers and gives failures precedence over completion', () => {
    const host = projection();
    host.state.completed.add('root');
    expect(projectTraySessions(host)[0]).toMatchObject({ status: 'completed', updatedAt: 123 });
    host.state.failed.add('root');
    expect(projectTraySessions(host)[0]?.status).toBe('error');
  });

  it('filters persisted reads without hiding a newer completion or unresolved attention', () => {
    const host = projection();
    host.state.completed.add('root');
    host.readState.root = 123;
    expect(projectTraySessions(host)).toEqual([]);
    host.state.isPlanSession = () => true;
    expect(projectTraySessions(host)).toEqual([]);
    host.readState.root = 122;
    expect(projectTraySessions(host)[0]?.status).toBe('plan-ready');
    host.readState.root = 1_000;
    host.state.pendingForUser.set('ask', {
      sessionID: 'child',
      kind: 'question',
      label: 'Question',
      props: {},
    });
    expect(projectTraySessions(host)[0]?.status).toBe('question');
    host.state.pendingForUser.clear();
    host.state.busy.add('root');
    expect(projectTraySessions(host)[0]?.status).toBe('running');
  });

  it('counts unseen errors and preserves pending requests after the chat has been read', () => {
    const host = projection();
    host.state.failed.add('root');
    host.readState.root = 123;
    expect(projectTraySessions(host)[0]).toMatchObject({ status: 'error', updatedAt: 124 });
    host.readState.root = 124;
    expect(projectTraySessions(host)).toEqual([]);
    host.state.failureMarkerFor = () => 125;
    expect(projectTraySessions(host)[0]?.status).toBe('error');
    host.readState.root = 1_000;
    host.state.pendingForUser.set('ask', {
      sessionID: 'root',
      kind: 'permission',
      label: 'Permission',
      props: {},
    });
    expect(projectTraySessions(host)[0]?.status).toBe('permission');
  });
});

describe.skipIf(process.platform === 'win32')(
  'optional tray publisher over a real Unix socket',
  () => {
    let directory: string;
    let socketPath: string;
    let server: Server | undefined;
    let publisher: MacOSTray | undefined;
    const clients = new Set<Socket>();
    let frames: TraySnapshot[];

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'vt-'));
      await chmod(directory, 0o700);
      socketPath = join(directory, 'tray.sock');
      frames = [];
    });

    afterEach(async () => {
      vi.useRealTimers();
      publisher?.dispose();
      publisher = undefined;
      for (const client of clients) client.destroy();
      clients.clear();
      if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
      await rm(directory, { recursive: true, force: true });
    });

    async function listen() {
      server = createServer((socket) => {
        clients.add(socket);
        socket.on('close', () => clients.delete(socket));
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          let end = buffer.indexOf('\n');
          while (end !== -1) {
            // Frames come from the production publisher, not an external writer.
            const snapshot: TraySnapshot = JSON.parse(buffer.slice(0, end));
            frames.push(snapshot);
            buffer = buffer.slice(end + 1);
            end = buffer.indexOf('\n');
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(socketPath, resolve);
      });
    }

    it('tolerates an absent app and connects later with a full snapshot', async () => {
      publisher = new MacOSTray(() => [row()], socketPath);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(frames).toEqual([]);
      await listen();
      await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 7_000 });
      expect(frames[0]).toMatchObject({
        version: 1,
        eventDriven: true,
        sessions: [expect.objectContaining({ status: 'running' })],
      });
    }, 10_000);

    it('does not poll, schedule updates, or project sessions while the app is absent', async () => {
      const sessions = vi.fn(() => [row()]);
      publisher = new MacOSTray(sessions, socketPath);
      await new Promise((resolve) => setTimeout(resolve, 30));
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
      publisher.update();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(sessions).not.toHaveBeenCalled();
      expect(frames).toEqual([]);
    });

    it('stays inert for the host lifetime when the app was never installed', async () => {
      socketPath = join(directory, 'tray', 'tray.sock');
      const sessions = vi.fn(() => [row()]);
      publisher = new MacOSTray(sessions, socketPath);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await mkdir(join(directory, 'tray'), { mode: 0o700 });
      await listen();
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
      publisher.update();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(clients.size).toBe(0);
      expect(sessions).not.toHaveBeenCalled();
    });

    it('stops socket discovery when disposed', async () => {
      const sessions = vi.fn(() => [row()]);
      publisher = new MacOSTray(sessions, socketPath);
      await new Promise((resolve) => setTimeout(resolve, 30));
      publisher.dispose();
      await listen();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(clients.size).toBe(0);
      expect(sessions).not.toHaveBeenCalled();
    });

    it('keeps an idle connection silent and suppresses unchanged host updates', async () => {
      await listen();
      const sessions = vi.fn(() => [row()]);
      const tray = new MacOSTray(sessions, socketPath);
      publisher = tray;
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      sessions.mockClear();
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(sessions).not.toHaveBeenCalled();
      vi.useRealTimers();
      await writeFile(join(directory, 'tray-history.json'), '{}');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(sessions).not.toHaveBeenCalled();
      tray.update();
      tray.update();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sessions).toHaveBeenCalledTimes(1);
      expect(frames).toHaveLength(1);
    });

    it('refuses a shared socket directory', async () => {
      await listen();
      await chmod(directory, 0o755);
      publisher = new MacOSTray(() => [row()], socketPath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(clients.size).toBe(0);
      expect(frames).toEqual([]);
    });

    it('publishes and refreshes open projects independently of session activity and backend readiness', async () => {
      await listen();
      let projects: TrayProject[] = [
        { id: '/idle', name: 'Idle project', url: 'vscode://file/idle' },
      ];
      const tray = new MacOSTray(
        () => [],
        socketPath,
        () => false,
        () => projects
      );
      publisher = tray;
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]).toMatchObject({ available: false, sessions: [], projects });
      projects = [{ id: '/added', name: 'Added project', url: 'vscode://file/added' }];
      tray.update();
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames.at(-1)?.projects).toEqual(projects);
      projects = [];
      tray.update();
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames.at(-1)?.projects).toEqual([]);
    });

    it('publishes unread completions and removes them after acknowledgement', async () => {
      await listen();
      let rows = [row()];
      const tray = new MacOSTray(() => rows, socketPath);
      publisher = tray;
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      const startedAt = frames[0]?.sessions[0]?.updatedAt;
      rows = [{ ...row(), title: 'Renamed chat' }];
      tray.update();
      tray.update();
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames.at(-1)?.sessions[0]?.updatedAt).toBe(startedAt);
      rows = [row('plan-ready', Date.now())];
      tray.update();
      await vi.waitFor(() => expect(frames.at(-1)?.sessions[0]?.status).toBe('plan-ready'));
      rows = [];
      tray.update();
      await vi.waitFor(() => expect(frames.at(-1)?.sessions).toEqual([]));
      rows = [row('completed', Date.now())];
      tray.update();
      await vi.waitFor(() => expect(frames.at(-1)?.sessions[0]?.status).toBe('completed'));
      rows = [];
      tray.update();
      await vi.waitFor(() => expect(frames.at(-1)?.sessions).toEqual([]));
      rows = [row('running')];
      tray.update();
      await vi.waitFor(() => expect(frames.at(-1)?.sessions[0]?.status).toBe('running'));
      expect(frames.at(-1)?.sessions).toHaveLength(1);
      rows = [];
      tray.update();
      await vi.waitFor(() => expect(frames.at(-1)?.sessions).toEqual([]));
    });

    it('preserves turn time across attention and resets for a coalesced successor turn', async () => {
      await listen();
      const firstStart = Date.now() - 60_000;
      let current = { ...row(), turnStartedAt: firstStart };
      const tray = new MacOSTray(() => [current], socketPath);
      publisher = tray;
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]?.sessions[0]?.turnStartedAt).toBe(firstStart);
      current = { ...current, status: 'question' };
      tray.update();
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      current = { ...current, status: 'running' };
      tray.update();
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames.at(-1)?.sessions[0]?.turnStartedAt).toBe(firstStart);
      const previousUpdate = frames.at(-1)?.sessions[0]?.updatedAt;
      current = { ...current, turnStartedAt: Date.now() };
      tray.update();
      await vi.waitFor(() => expect(frames).toHaveLength(4));
      expect(frames.at(-1)?.sessions[0]?.turnStartedAt).toBe(current.turnStartedAt);
      expect(frames.at(-1)?.sessions[0]?.updatedAt).toBeGreaterThan(previousUpdate ?? 0);
      current = { ...current, title: 'Renamed chat' };
      tray.update();
      await vi.waitFor(() => expect(frames).toHaveLength(5));
      expect(frames.at(-1)?.sessions[0]?.turnStartedAt).toBe(current.turnStartedAt);
      expect(frames.at(-1)?.sessions[0]?.updatedAt).toBe(frames.at(-2)?.sessions[0]?.updatedAt);
    });

    it('does not replay completions read before a coalesced update is sent', async () => {
      await listen();
      let rows = [row()];
      publisher = new MacOSTray(() => rows, socketPath);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      rows = [row('completed', Date.now())];
      publisher.update();
      rows = [];
      publisher.update();
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames.at(-1)?.sessions).toEqual([]);
    });

    it.each(['completed', 'plan-ready', 'permission', 'question', 'error'] as const)(
      'keeps %s attention until the authoritative session snapshot clears it',
      async (status) => {
        await listen();
        let rows = [row(status, 123)];
        const tray = new MacOSTray(() => rows, socketPath);
        publisher = tray;
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        expect(frames[0]?.sessions[0]?.status).toBe(status);
        rows = [{ ...row(status, 123), title: 'Renamed chat' }];
        tray.update();
        await vi.waitFor(() => expect(frames).toHaveLength(2));
        expect(frames.at(-1)?.sessions[0]?.status).toBe(status);
        rows = [];
        tray.update();
        await vi.waitFor(() => expect(frames.at(-1)?.sessions).toEqual([]));
      }
    );

    it('reconnects after a dropped connection with the same instance ID and stops on disposal', async () => {
      await listen();
      publisher = new MacOSTray(() => [row()], socketPath);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      const id = frames[0]?.instanceID;
      for (const client of clients) client.destroy();
      await vi.waitFor(() => expect(frames).toHaveLength(2), { timeout: 7_000 });
      expect(frames[1]?.instanceID).toBe(id);
      publisher.dispose();
      await vi.waitFor(() => expect(clients.size).toBe(0));
    }, 10_000);

    it('reconnects when the app restarts and replaces its socket', async () => {
      await listen();
      publisher = new MacOSTray(() => [row()], socketPath);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      const id = frames[0]?.instanceID;
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      await listen();
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(1));
      await vi.waitFor(() => expect(frames.at(-1)?.instanceID).toBe(id));
      await vi.waitFor(() => expect(clients.size).toBe(1));
    });

    it('does not spin against a peer that closes every connection', async () => {
      let attempts = 0;
      server = createServer((socket) => {
        attempts += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
      publisher = new MacOSTray(() => [row()], socketPath);
      await vi.waitFor(() => expect(attempts).toBe(2));
      publisher.update();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(attempts).toBe(2);
    });
  }
);
