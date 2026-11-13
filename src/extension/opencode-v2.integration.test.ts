/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- The VS Code logger is mocked; all OpenCode requests use an isolated real server. Assertions narrow fixture response shapes. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Duplex } from 'node:stream';
import type { ProgressOptions, Uri } from 'vscode';
import { setTimeout as delay } from 'node:timers/promises';
import { asRecord, isString, type UnknownRecord } from '../shared/type-utils';
import { parseServerEvent } from '../shared/protocol';
import { parseHealthResponse } from '../shared/health';
import { OpenCodeTransport } from './open-code-transport';
import { getOpenCodeApiCapabilities } from './opencode-api-capabilities';
import { compareVersions } from './server-utils';
import { basicAuthorization, OpenCodeStartupOutput } from './opencode-connection';
import { tryGenerateOneShot } from './one-shot-generation';
import { NativeDecisions } from './native-decisions';
import { SessionExportService } from './session-export-service';
import { getAssistantDialogSummaryMap } from '../webview/components/message-list/assistant-dialog';
import type { MessageEntry } from '../webview/types';
import { logger } from './logger';
import { readLocalSessionSummary } from './local-session-summary';
import { sessionSummary } from './session-summary';
import { formatSkillAttachment, parseSkillAttachment } from '../shared/skill-reference';
import { completeTestCleanup, IsolatedProcessTree } from './isolated-process.test-support';
import { OpenCodeConfigService } from './opencode-config-service';
import { ServerMemoryPermissionStore } from './server-memory-permission-store';
import type { RestProxyCallbacks } from './rest-proxy';
import type { Persistence } from '../shared/persistence';
import type { OpenCodeServerMemoryPermission, PermissionRule } from '../shared/opencode-types';
import { fixture } from '../webview/test-fixtures';
import { readAllTimeUsageCsv, UsageReportService } from './usage-report-service';

const exportEditor = vi.hoisted(() => ({
  openTextDocument: vi.fn(async (options: { content: string; language: string }) => options),
  showTextDocument: vi.fn(),
  showErrorMessage: vi.fn(),
}));
vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn() },
  workspace: { openTextDocument: exportEditor.openTextDocument },
  window: {
    showTextDocument: exportEditor.showTextDocument,
    showErrorMessage: exportEditor.showErrorMessage,
    withProgress: async (_options: ProgressOptions, task: () => Promise<string>) => task(),
  },
}));

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const binary = process.env.VARRO_OPENCODE_TEST_BINARY;

describe.skipIf(!binary)('released OpenCode adapter contract', () => {
  let child: ChildProcess;
  let childTree: IsolatedProcessTree | undefined;
  let modelServer: Server;
  let transport: OpenCodeTransport;
  let root: string;
  let url = '';
  let authorization: string | undefined;
  const events: unknown[] = [];
  const modelRequests: unknown[] = [];
  let sessionID = '';
  let streamGate: Promise<void> | undefined;
  const providerPrompts: unknown[][] = [];
  const silentSockets = new Set<Duplex>();
  let silentRequests = 0;

  beforeAll(async () => {
    const parent = resolve('artifacts/ai-test-data');
    await mkdir(parent, { recursive: true });
    root = await mkdtemp(join(parent, 'adapter-'));
    for (const name of ['home', 'data', 'config', 'state', 'cache', 'workspace'])
      await mkdir(join(root, name));
    const git = spawnSync('git', ['init', '--quiet'], { cwd: join(root, 'workspace') });
    if (git.status !== 0) throw new Error('Could not initialize isolated fixture repository');
    await writeFile(join(root, 'workspace/probe.txt'), 'isolated tool fixture\n');
    const skillDirectory = join(root, 'workspace/.opencode/skills/fixture-skill');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: A command compatibility fixture\n---\nReply with the fixture response. Do not call tools.\n'
    );
    modelServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = asRecord(JSON.parse(Buffer.concat(chunks).toString()));
      modelRequests.push(payload);
      if (payload?.model === 'fixture-error') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { message: 'Fixture child execution failed', type: 'invalid_request_error' },
          })
        );
        return;
      }
      if (payload?.stream === true) {
        await streamGate;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const messages = Array.isArray(payload.messages) ? payload.messages.map(asRecord) : [];
        providerPrompts.push(messages);
        const lastUser = messages.findLastIndex((message) => message?.role === 'user');
        const tools = Array.isArray(payload.tools) ? payload.tools.map(asRecord) : [];
        const read = tools
          .map((tool) => asRecord(tool?.function))
          .find((tool) => tool?.name === 'read');
        if (
          read &&
          JSON.stringify(messages[lastUser]?.content).includes('RUN_READ_FIXTURE') &&
          !messages.slice(lastUser + 1).some((message) => message?.role === 'tool')
        ) {
          const fields = asRecord(asRecord(read.parameters)?.properties) ?? {};
          const args = {
            [fields.filePath ? 'filePath' : 'path']: join(root, 'workspace/probe.txt'),
          };
          response.write(
            `data: ${JSON.stringify({ id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fixture_read', type: 'function', function: { name: 'read', arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`
          );
          response.end(
            `data: ${JSON.stringify({ id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`
          );
          return;
        }
        for (const text of ['Adapter ', 'stream ', 'verified.']) {
          response.write(
            `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
          );
          await delay(20);
        }
        response.end(
          `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`
        );
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'chatcmpl-fixture',
            object: 'chat.completion',
            created: 1,
            model: 'fixture',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Adapter stream verified.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          })
        );
      }
    });
    modelServer.on('upgrade', (request, socket) => {
      const key = request.headers['sec-websocket-key'];
      if (!isString(key)) {
        socket.destroy();
        return;
      }
      silentSockets.add(socket);
      socket.on('close', () => silentSockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.on('data', () => {
        silentRequests += 1;
      });
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      // Accept the request, then deliberately send no provider frames.
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
    });
    await new Promise<void>((done) => modelServer.listen(0, '127.0.0.1', done));
    const address = modelServer.address();
    if (!address || isString(address)) throw new Error('Fixture server did not bind');
    await writeFile(
      join(root, 'workspace/opencode.json'),
      JSON.stringify({
        model: 'fixture/fixture',
        command: { 'fixture-note': { template: 'Reply with the fixture response.' } },
        agent: {
          ask: {
            mode: 'primary',
            prompt: 'ASK_MODE_FIXTURE: This turn is read-only. Do not modify files.',
            permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow' },
          },
          'icon-legacy-json': { mode: 'primary', icon: 'binocular' },
          'icon-options-json': { mode: 'primary', options: { icon: 'cube-scan-solid' } },
          'icon-vision-json': { mode: 'subagent', icon: 'eye' },
          'icon-default': { mode: 'primary' },
        },
        provider: {
          fixture: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Fixture',
            options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-only' },
            models: {
              fixture: {
                name: 'Fixture',
                cost: { input: 2, output: 8 },
                limit: { context: 32000, output: 1000 },
              },
            },
          },
        },
      })
    );
    const agentDirectory = join(root, 'workspace/.opencode/agents');
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, 'icon-legacy-markdown.md'),
      '---\ndescription: Icon fixture\nmode: subagent\nicon: eye\n---\nDescribe images.\n'
    );
    const output = new OpenCodeStartupOutput((password) => {
      authorization = basicAuthorization(password);
    });
    const version =
      process.env.VARRO_OPENCODE_TEST_VERSION ??
      spawnSync(binary!, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout.trim();
    if (/^(?:opencode\s+v?)?2\./.test(version)) {
      const commandDirectory = join(root, 'workspace/.opencode/commands');
      await mkdir(commandDirectory, { recursive: true });
      await writeFile(
        join(commandDirectory, 'fixture-audit.md'),
        '---\ndescription: Audit fixture\nagent: general\nmodel: fixture/fixture-command\nsubagent: true\n---\nAudit $ARGUMENTS. Do not call tools.\n'
      );
      await writeFile(
        join(commandDirectory, 'fixture-launch-error.md'),
        '---\nagent: fixture-agent-does-not-exist\nsubagent: true\n---\nReply.\n'
      );
      await writeFile(
        join(commandDirectory, 'fixture-child-error.md'),
        '---\nagent: general\nmodel: fixture/fixture-error\nsubagent: true\n---\nReply.\n'
      );
      await mkdir(join(root, 'config/opencode'), { recursive: true });
      await writeFile(
        join(root, 'config/opencode/opencode.json'),
        JSON.stringify({
          skills: [join(root, 'workspace/.opencode/skills')],
          agents: {
            'icon-native-json': { mode: 'primary', request: { body: { icon: 'code-brackets' } } },
          },
          providers: {
            silent: {
              package: '@opencode/ai/providers/openai',
              settings: {
                baseURL: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'fixture-only',
                transport: 'websocket',
              },
              models: {
                'gpt-4o': { name: 'Silent fixture', limit: { context: 32000, output: 1000 } },
              },
            },
            fixture: {
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-only' },
              models: {
                fixture: { name: 'Fixture', limit: { context: 32000, output: 1000 } },
                'fixture-command': {
                  name: 'Command fixture',
                  limit: { context: 32000, output: 1000 },
                },
                'fixture-error': {
                  name: 'Failing child fixture',
                  limit: { context: 32000, output: 1000 },
                },
              },
            },
          },
        })
      );
    }
    let logs = '';
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_DB: join(root, 'data/probe.db'),
      OPENCODE_TEST_HOME: join(root, 'home'),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
    };
    if (/^(?:opencode\s+v?)?2\./.test(version)) {
      env.OPENCODE_DISABLE_FREE_MODELS = 'true';
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        providers: { openai: { settings: { chunkTimeout: 300000 } } },
      });
    }
    child = crossSpawn(binary!, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: join(root, 'workspace'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    childTree = new IsolatedProcessTree(child);
    const collect = (chunk: Buffer) => {
      logs += output.write(chunk);
      url = logs.match(/server listening on (http:\/\/\S+)/)?.[1] ?? '';
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    await vi.waitFor(
      () => {
        if (child.exitCode !== null) throw new Error(logs);
        expect(url).not.toBe('');
      },
      { timeout: 20000 }
    );
    transport = new OpenCodeTransport({
      getUrl: () => url,
      getWorkspaceCwd: () => join(root, 'workspace'),
      getStatus: () => ({ state: 'running', url }),
      isDisposing: () => false,
      updateEventStreamState: () => {},
      emitEvent: (event) => events.push(event),
      getAuthorization: () => authorization,
      sessionStateDirectory: join(root, 'annotations'),
    });
    await vi.waitFor(async () => expect((await transport.readHealthInfo()).healthy).toBe(true), {
      timeout: 20000,
    });
    await childTree.captureListener(Number(new URL(url).port));
    if (process.env.VARRO_OPENCODE_TEST_VERSION)
      expect((await transport.readHealthInfo()).version).toBe(
        process.env.VARRO_OPENCODE_TEST_VERSION
      );
    void transport.startEventStream();
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  }, 60000);

  afterAll(async () => {
    await completeTestCleanup([
      () => {
        transport?.stopEventStream();
        transport?.abortRequests();
      },
      () => childTree?.stop(),
      async () => {
        modelServer?.closeAllConnections();
        for (const socket of silentSockets) socket.destroy();
        await new Promise<void>((done) => (modelServer ? modelServer.close(() => done()) : done()));
      },
      async () => {
        if (root) await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
      },
    ]);
  });

  it('reads native bare project and worktree inventories for move authorization', async (context) => {
    if (transport.version !== 2) return context.skip();
    const project = asRecord(await transport.request('GET', '/project/current'));
    if (!isString(project?.id)) throw new Error('Missing isolated workspace project');
    const projects = await transport.request('GET', '/project');
    expect(Array.isArray(projects)).toBe(true);
    expect(projects).toContainEqual(expect.objectContaining({ id: project.id, vcs: 'git' }));
    const worktrees = await transport.request(
      'GET',
      `/experimental/worktree?projectID=${encodeURIComponent(project.id)}`
    );
    expect(Array.isArray(worktrees)).toBe(true);
    expect(worktrees).toContainEqual(
      expect.objectContaining({ directory: join(root, 'workspace') })
    );
    expect(modelRequests).toHaveLength(0);
  });

  it('continues a real isolated conversation after moving into a registered Git worktree', async (context) => {
    if (transport.version !== 2) return context.skip();
    const workspace = join(root, 'worktree-project');
    const hooks = join(root, 'empty-git-hooks');
    await mkdir(workspace);
    await mkdir(hooks);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    );
    for (const args of [
      ['init', '--quiet', '--template='],
      [
        '-c',
        'user.name=Varro test',
        '-c',
        'user.email=varro-test@example.invalid',
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'Isolated worktree fixture',
      ],
    ]) {
      const result = spawnSync('git', args, { cwd: workspace, env, encoding: 'utf8' });
      if (result.status !== 0)
        throw new Error(`Could not initialize worktree fixture: ${result.stderr}`);
    }
    const project = asRecord(
      await transport.request('GET', '/project/current', undefined, {
        directory: workspace,
      })
    );
    if (!isString(project?.id)) throw new Error('Missing isolated Git project');
    const worktree = asRecord(
      await transport.request(
        'POST',
        '/api/worktree',
        {
          projectID: project.id,
          directory: join(root, 'worktrees'),
          name: 'continued-chat',
        },
        { directory: workspace }
      )
    );
    if (!isString(worktree?.directory)) throw new Error('Missing isolated worktree');
    const created = asRecord(
      await transport.request(
        'POST',
        '/session',
        {
          title: 'Worktree continuation fixture',
          model: { providerID: 'fixture', modelID: 'fixture' },
        },
        { directory: workspace }
      )
    );
    if (!isString(created?.id)) throw new Error('Missing isolated continuation session');
    const id = created.id;
    try {
      await transport.request('POST', `/api/session/${id}/move`, { directory: worktree.directory });
      await vi.waitFor(async () => {
        const moved = await transport.request('GET', `/session/${id}`);
        expect(moved).toMatchObject({ projectID: project.id, directory: worktree.directory });
      });
      const inventory = await transport.request(
        'GET',
        `/experimental/worktree?projectID=${encodeURIComponent(project.id)}`
      );
      expect(inventory).toContainEqual(expect.objectContaining({ directory: worktree.directory }));
      const reply = await transport.request(
        'POST',
        `/session/${id}/message`,
        {
          parts: [{ type: 'text', text: 'Continue from this worktree. Do not call tools.' }],
          model: { providerID: 'fixture', modelID: 'fixture' },
        },
        { directory: worktree.directory }
      );
      expect(reply).toMatchObject({
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'Adapter stream verified.' }),
        ]),
      });
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30_000);

  it('reports native side-question and warming usage without adding assistant messages', async (context) => {
    const health = await transport.readHealthInfo();
    if (transport.version !== 2 || compareVersions(health.version ?? '0', '2.2.7') < 0)
      return context.skip();
    const created = asRecord(
      await transport.request('POST', '/session', {
        title: 'Auxiliary usage fixture',
        model: { providerID: 'fixture', modelID: 'fixture' },
      })
    );
    if (!isString(created?.id)) throw new Error('Missing isolated auxiliary usage session');
    const id = created.id;
    try {
      vi.stubEnv('OPENCODE_DB', join(root, 'data/probe.db'));
      vi.stubEnv('VARRO_TEST_STATE_ROOT', join(root, 'usage-state'));
      expect(
        await transport.request('POST', `/session/${id}/side-question`, { question: 'Why?' })
      ).toEqual({ text: 'Adapter stream verified.' });
      await transport.request('POST', `/api/session/${id}/generate`, {
        prompt: 'This is a keep-alive request. Reply with exactly: OK',
      });
      expect(await transport.request('GET', `/session/${id}/message`)).toEqual([]);
      const csv = await readAllTimeUsageCsv();
      const database = new DatabaseSync(join(root, 'data/probe.db'), { readOnly: true });
      try {
        await writeFile(
          join(root, 'auxiliary-events.json'),
          JSON.stringify(
            database.prepare('SELECT type,data FROM event WHERE aggregate_id=?').all(id),
            null,
            2
          )
        );
      } finally {
        database.close();
      }
      await writeFile(join(root, 'auxiliary-usage.csv'), csv.csv);
      await writeFile(
        join(root, 'auxiliary-usage.log'),
        String(
          await transport.request('GET', `/api/experimental/session/${id}/log?follow=false&after=0`)
        )
      );
      const generation = csv.csv.split('\r\n').find((row) => row.includes(',unrecorded,'));
      expect(generation?.split(',')).toEqual([
        'unknown',
        'unknown',
        'unknown',
        'unknown',
        '0',
        '20',
        '6',
        '0',
        '0',
        '0',
        '26',
        '0.000088',
        '0',
        'unrecorded',
        '',
        '',
      ]);
      let report = '';
      const request = async (...args: Parameters<OpenCodeTransport['request']>) =>
        args[1].startsWith('/experimental/session')
          ? [await transport.request('GET', `/session/${id}`)]
          : transport.request(...args);
      await new UsageReportService(
        { request, apiVersion: 2, isAttachOnly: true },
        async () => undefined,
        null,
        async (content) => {
          report = content;
          return fixture<Uri>({ scheme: 'untitled', path: '/usage' });
        }
      ).openReport();
      expect(report).toContain('| Unattributed | Other session usage | 0 | 26 | - |');
      expect(report).not.toContain('## Warnings');
    } finally {
      vi.unstubAllEnvs();
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('bounds silent provider WebSockets after reloading an old runtime timeout policy', async (context) => {
    const health = await transport.readHealthInfo();
    if (transport.version !== 2 || compareVersions(health.version ?? '0', '2.0.20') < 0) {
      context.skip();
      return;
    }
    const providerPath = `/api/provider/silent?location[directory]=${encodeURIComponent(join(root, 'workspace'))}`;
    await vi.waitFor(
      async () => {
        expect(asRecord(await transport.request('GET', providerPath))?.data).toBeDefined();
      },
      { timeout: 10000, interval: 100 }
    );
    const settingsBefore = asRecord(
      asRecord(asRecord(await transport.request('GET', providerPath))?.data)?.settings
    );
    expect(settingsBefore).not.toHaveProperty('chunkTimeout');
    const configPath = join(root, 'config/opencode/opencode.json');
    const config = asRecord(JSON.parse(await readFile(configPath, 'utf-8')));
    const settings = asRecord(asRecord(asRecord(config?.providers)?.silent)?.settings);
    if (!settings) throw new Error('Missing isolated silent provider settings');
    settings.chunkTimeout = 200;
    await writeFile(configPath, JSON.stringify(config));
    await transport.request('POST', '/global/dispose');
    await vi.waitFor(
      async () => {
        expect(
          asRecord(asRecord(asRecord(await transport.request('GET', providerPath))?.data)?.settings)
            ?.chunkTimeout
        ).toBe(200);
      },
      { timeout: 10000, interval: 100 }
    );
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Silent stream fixture' })
    );
    if (!isString(session?.id)) throw new Error('Missing silent stream fixture session');
    const id = session.id;
    const previousRequests = silentRequests;
    try {
      await transport.request('POST', `/session/${id}/prompt_async`, {
        agent: 'build',
        model: { providerID: 'silent', modelID: 'gpt-4o' },
        parts: [{ type: 'text', text: 'Reply without tools.' }],
      });
      await vi.waitFor(() => expect(silentRequests).toBeGreaterThan(previousRequests), {
        timeout: 10000,
      });
      await vi.waitFor(
        () => {
          expect(
            events.some((event) => {
              const properties = asRecord(parseServerEvent(event)?.properties);
              return (
                properties?.sessionID === id &&
                JSON.stringify(properties).includes('Timed out waiting for WebSocket data')
              );
            })
          ).toBe(true);
        },
        { timeout: 10000 }
      );
    } finally {
      await transport.request('POST', `/session/${id}/abort`);
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 25000);

  it('exports from a password-protected V2 server using the authenticated connection', async () => {
    if (transport.version !== 2) return;
    expect(authorization).toMatch(/^Basic /);
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Export fixture' })
    );
    const id = session?.id;
    if (!isString(id)) throw new Error('Missing export fixture session');
    const service = new SessionExportService(
      {
        apiVersion: 2,
        isAttachOnly: true,
        getWorkspaceCwd: () => join(root, 'workspace'),
        request: transport.request.bind(transport),
        resolveCommand: () => {
          throw new Error('V2 export must use the authenticated API');
        },
      },
      20000
    );
    try {
      await service.exportSession(id);
      const document = exportEditor.openTextDocument.mock.calls.at(-1)?.[0];
      expect(document?.language).toBe('json');
      expect(JSON.parse(document!.content)).toMatchObject({
        info: { id, title: 'Export fixture' },
        messages: [],
      });
      expect(exportEditor.showTextDocument).toHaveBeenCalled();
      expect(exportEditor.showErrorMessage).not.toHaveBeenCalled();
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  });

  it('reads native V2 session summaries directly from the isolated database', async () => {
    if (transport.version !== 2) return;
    const created = asRecord(
      await transport.request('POST', '/session', { title: 'Local summary fixture' })
    );
    if (!isString(created?.id)) throw new Error('Missing local summary fixture session');
    const id = created.id;
    try {
      await transport.request('POST', `/session/${id}/prompt_async`, {
        agent: 'build',
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'Return the fixture response without tools.' }],
      });
      await vi.waitFor(
        async () => {
          const local = await readLocalSessionSummary(id, join(root, 'data/probe.db'), 2);
          const assistant = local?.messages
            .map((message) => asRecord(asRecord(message)?.info))
            .findLast((info) => info?.role === 'assistant');
          expect(asRecord(assistant?.time)?.completed).toBeGreaterThan(0);
          expect(asRecord(assistant?.tokens)?.output).toBeGreaterThan(0);
        },
        { timeout: 15000 }
      );
      const local = await readLocalSessionSummary(id, join(root, 'data/probe.db'), 2);
      if (!local) throw new Error('Native V2 database summary unavailable');
      const messages = await transport.request('GET', `/session/${id}/message`);
      const remote = await sessionSummary.fromRemote([], messages, [], async () => []);
      expect(sessionSummary.fromLocal(local)).toMatchObject({
        tokens: remote.tokens,
        durationMs: remote.durationMs,
        model: remote.model,
        tokenBreakdown: remote.tokenBreakdown,
        nestedContextBreakdown: remote.nestedContextBreakdown,
      });
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 20000);

  it('restores estimated generation speed from durable boundaries after a cold reconnect', async () => {
    if (transport.version !== 2) return;
    const created = asRecord(
      await transport.request('POST', '/session', { title: 'Generation timing fixture' })
    );
    if (!isString(created?.id)) throw new Error('Missing generation timing fixture session');
    const id = created.id;
    const cold = new OpenCodeTransport({
      getUrl: () => url,
      getWorkspaceCwd: () => join(root, 'workspace'),
      getStatus: () => ({ state: 'running', url }),
      isDisposing: () => false,
      updateEventStreamState: () => {},
      emitEvent: () => {},
      getAuthorization: () => authorization,
      sessionStateDirectory: join(root, 'annotations'),
    });
    try {
      await transport.request('POST', `/session/${id}/prompt_async`, {
        agent: 'build',
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'Return the fixture response without tools.' }],
      });
      await vi.waitFor(
        async () => {
          // SAFETY: The real adapter returns the canonical Varro message-entry contract.
          const messages = (await transport.request(
            'GET',
            `/session/${id}/message`
          )) as MessageEntry[];
          const summary = [...getAssistantDialogSummaryMap(messages).values()].at(-1);
          expect(summary?.tokensPerSecond).toBeGreaterThan(0);
        },
        { timeout: 15000 }
      );
      expect(await cold.checkHealth()).toBe(true);
      // SAFETY: The cold authenticated transport uses the same canonical adapter contract.
      const messages = (await cold.request('GET', `/session/${id}/message`)) as MessageEntry[];
      await writeFile(
        join(root, 'generation-timing.json'),
        JSON.stringify(
          {
            messages,
            warnings: vi.mocked(logger.warn).mock.calls,
          },
          null,
          2
        )
      );
      const summary = [...getAssistantDialogSummaryMap(messages).values()].at(-1);
      expect(summary?.tokensPerSecond).toBeGreaterThan(0);
      expect(summary?.outputTokens).toBe(3);
      const assistant = messages.findLast((entry) => entry.info.role === 'assistant');
      expect(assistant?.parts.find((part) => part.type === 'text')?.time?.end).toBeGreaterThan(0);
    } finally {
      cold.abortRequests();
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('generates with a configured custom model or falls back without duplicate generation', async () => {
    if (transport.version !== 2) return;
    expect(
      JSON.stringify(await transport.request('GET', '/api/config', undefined, { unscoped: true }))
    ).toContain('fixture');
    const before = await transport.request('GET', '/session');
    const requestCount = modelRequests.length;
    const result = await tryGenerateOneShot(
      { apiVersion: 2, request: transport.request.bind(transport) },
      {
        prompt: 'Return the fixture response.',
        model: { providerID: 'fixture', modelID: 'fixture' },
        directory: join(root, 'workspace'),
        signal: AbortSignal.timeout(20000),
      }
    );
    // 2.0.27 waits for location plugins before resolving configured providers.
    // Earlier releases need the helper-session fallback without a provider call.
    const supportsConfiguredGeneration =
      compareVersions((await transport.readHealthInfo()).version ?? '', '2.0.27') >= 0;
    expect(result).toEqual(
      supportsConfiguredGeneration ? { text: 'Adapter stream verified.' } : null
    );
    expect(modelRequests).toHaveLength(requestCount + (supportsConfiguredGeneration ? 1 : 0));
    expect(await transport.request('GET', '/session')).toEqual(before);
    if (result) return;
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Fixture helper fallback' })
    );
    const id = session?.id;
    if (!isString(id)) throw new Error('Missing fallback fixture session');
    try {
      const generated = asRecord(
        await transport.request('POST', `/session/${id}/message`, {
          model: { providerID: 'fixture', modelID: 'fixture' },
          parts: [{ type: 'text', text: 'Return the fixture response.' }],
          format: { type: 'json_schema', schema: { type: 'object' } },
        })
      );
      expect(generated?.parts).toEqual([{ type: 'text', text: 'Adapter stream verified.' }]);
      expect(modelRequests).toHaveLength(requestCount + 1);
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  });

  it('identifies an unavailable base model before any provider request', async () => {
    if (transport.version !== 2) return;
    const before = modelRequests.length;
    const result = await tryGenerateOneShot(
      { apiVersion: 2, request: transport.request.bind(transport) },
      {
        prompt: 'Do not call a provider for this unavailable model.',
        model: { providerID: 'not-in-base-config', modelID: 'unavailable' },
        directory: join(root, 'workspace'),
        signal: AbortSignal.timeout(20000),
      }
    );
    expect(result).toBeNull();
    expect(modelRequests).toHaveLength(before);
  });

  it('preserves configured JSON agent icons through the released backend and adapter', async () => {
    const before = modelRequests.length;
    const response = await transport.request('GET', '/agent');
    await writeFile(join(root, 'agent-icons.json'), JSON.stringify(response, null, 2));
    expect(Array.isArray(response)).toBe(true);
    const agents = (response as UnknownRecord[]).map(asRecord);
    const expected = [
      { name: 'icon-legacy-json', mode: 'primary', options: { icon: 'binocular' } },
      { name: 'icon-options-json', mode: 'primary', options: { icon: 'cube-scan-solid' } },
      { name: 'icon-vision-json', mode: 'subagent', options: { icon: 'eye' } },
    ];
    if (transport.version === 2) {
      expected.push({
        name: 'icon-native-json',
        mode: 'primary',
        options: { icon: 'code-brackets' },
      });
    }
    for (const agent of expected) {
      expect(agents.find((entry) => entry?.name === agent.name)).toMatchObject(agent);
    }
    const defaultAgent = agents.find((entry) => entry?.name === 'icon-default');
    expect(defaultAgent).toBeDefined();
    expect(asRecord(defaultAgent?.options)?.icon).toBeUndefined();
    expect(modelRequests).toHaveLength(before);
  });

  it('preserves configured Markdown agent icons on v1', async (context) => {
    if (transport.version === 2) {
      context.skip('Released v2 catalogs omit Markdown-defined agents');
    }
    const agents = (await transport.request('GET', '/agent')) as UnknownRecord[];
    expect(agents.find((agent) => agent.name === 'icon-legacy-markdown')).toMatchObject({
      mode: 'subagent',
      options: { icon: 'eye' },
    });
  });

  it('loads bootstrap catalogs', async () => {
    // Exercise the webview's public health route, not only the process startup probe.
    const health = parseHealthResponse(await transport.request('GET', '/global/health'));
    expect(health?.healthy).toBe(true);
    if (process.env.VARRO_OPENCODE_TEST_VERSION)
      expect(health?.version).toBe(process.env.VARRO_OPENCODE_TEST_VERSION);
    const agents = await transport.request('GET', '/agent');
    expect(Array.isArray(agents)).toBe(true);
    // Native plugin activation and registry updates are asynchronous.
    await vi.waitFor(
      async () => {
        const commands = (await transport.request('GET', '/command')) as UnknownRecord[];
        const command = commands.find((entry) => entry.name === 'fixture-note');
        expect(command).toBeDefined();
        if (transport.version === 2) {
          expect(command).toMatchObject({ description: '', source: 'command', template: '' });
        } else {
          expect(isString(command?.description || command?.template)).toBe(true);
        }
      },
      { timeout: 10000 }
    );
    const providers = asRecord(await transport.request('GET', '/provider'));
    await writeFile(
      join(root, 'native-bootstrap.json'),
      JSON.stringify(
        {
          default: await transport.request('GET', '/api/model/default'),
          providers: await transport.request('GET', '/api/provider'),
          models: await transport.request('GET', '/api/model'),
        },
        null,
        2
      )
    );
    await writeFile(join(root, 'providers.json'), JSON.stringify(providers, null, 2));
    await writeFile(
      join(root, 'bootstrap.json'),
      JSON.stringify(
        {
          location: await transport.request('GET', '/path'),
          config: await transport.request('GET', '/config'),
        },
        null,
        2
      )
    );
    // Config-only providers are usable without a saved integration connection.
    expect(providers?.all).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'fixture', source: 'config' })])
    );
    expect(asRecord(await transport.request('GET', '/config/providers'))?.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'fixture',
          models: expect.objectContaining({
            fixture: expect.objectContaining({
              id: 'fixture',
              cost: expect.objectContaining({ input: 2, output: 8 }),
              limit: expect.objectContaining({ context: 32000, output: 1000 }),
            }),
          }),
        }),
      ])
    );
    expect(await transport.request('GET', '/permission')).toEqual([]);
    expect(await transport.request('GET', '/question')).toEqual([]);
    expect(await transport.request('GET', '/session/status')).toEqual({});
    expect(await transport.request('GET', '/experimental/session?limit=1000')).toEqual([]);
  }, 60000);

  it.each(['日本語 🚀', 'literal%2Fdirectory'])(
    'resolves the exact workspace path for %s',
    async (name) => {
      const directory = join(root, 'workspace', name);
      await mkdir(directory);
      const location = asRecord(await transport.request('GET', '/path', undefined, { directory }));
      expect(location?.directory).toBe(directory);
    }
  );

  it('loads v2 configuration above the Git root and applies .opencode overrides last', async (context) => {
    if (transport.version !== 2) return context.skip();
    const ancestor = join(root, 'config-precedence');
    const repository = join(ancestor, 'repo');
    const directory = join(repository, 'package');
    await mkdir(directory, { recursive: true });
    await mkdir(join(ancestor, '.opencode'));
    expect(spawnSync('git', ['init', '--quiet'], { cwd: repository }).status).toBe(0);
    await writeFile(
      join(ancestor, 'opencode.json'),
      JSON.stringify({
        agents: {
          'fixture-review': { model: 'fixture/ancestor', description: 'Inherited above Git root' },
        },
      })
    );
    await writeFile(
      join(directory, 'opencode.json'),
      JSON.stringify({
        agents: { 'fixture-review': { model: 'fixture/direct' } },
      })
    );
    await writeFile(
      join(ancestor, '.opencode/opencode.json'),
      JSON.stringify({
        agents: { 'fixture-review': { model: 'fixture/hidden' } },
      })
    );
    const config = asRecord(await transport.request('GET', '/config', undefined, { directory }));
    expect(asRecord(config?.agent)?.['fixture-review']).toMatchObject({
      model: 'fixture/hidden',
      description: 'Inherited above Git root',
    });
  });

  it('does not restore configured providers denied by native v2 policies', async (context) => {
    const health = await transport.readHealthInfo();
    if (transport.version !== 2 || compareVersions(health.version ?? '0', '2.0.29') < 0)
      return context.skip();
    const directory = join(root, 'native-provider-policy');
    await mkdir(directory);
    await writeFile(
      join(directory, 'opencode.json'),
      JSON.stringify({
        providers: {
          'blocked-fixture': {
            package: '@opencode/ai/providers/openai-compatible',
            models: { fixture: {} },
          },
        },
        policies: [{ action: 'provider.use', resource: 'blocked-fixture', effect: 'deny' }],
      })
    );
    const config = asRecord(await transport.request('GET', '/config', undefined, { directory }));
    expect(asRecord(config?.providers)?.['blocked-fixture']).toBeDefined();
    expect(config?.policies).toContainEqual({
      action: 'provider.use',
      resource: 'blocked-fixture',
      effect: 'deny',
    });
    const providers = asRecord(
      await transport.request('GET', '/provider', undefined, { directory })
    );
    expect(providers?.all).toEqual(expect.any(Array));
    expect(providers?.all).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'blocked-fixture' })])
    );
    const configured = asRecord(
      await transport.request('GET', '/config/providers', undefined, { directory })
    );
    expect(configured?.providers).toEqual(expect.any(Array));
    expect(configured?.providers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'blocked-fixture' })])
    );
  });

  it('does not restore free models hidden by the native v2 catalog', async (context) => {
    const health = await transport.readHealthInfo();
    if (transport.version !== 2 || compareVersions(health.version ?? '0', '2.1.2') < 0)
      return context.skip();
    const directory = join(root, 'native-free-models');
    await mkdir(directory);
    await writeFile(
      join(directory, 'opencode.json'),
      JSON.stringify({
        providers: Object.fromEntries(
          ['opencode', 'opencode-go'].map((id) => [
            id,
            {
              package: '@opencode/ai/providers/openai-compatible',
              settings: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only' },
              models: {
                'free-fixture': { cost: { input: 0, output: 0 } },
              },
            },
          ])
        ),
      })
    );
    const native = asRecord(
      await transport.request(
        'GET',
        `/api/model?location[directory]=${encodeURIComponent(directory)}`
      )
    );
    expect(native?.data).toEqual(expect.any(Array));
    expect(native?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerID: 'fixture', id: 'fixture' })])
    );
    for (const id of ['opencode', 'opencode-go']) {
      expect(native?.data).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ providerID: id, id: 'free-fixture' })])
      );
    }
    for (const route of ['/provider', '/config/providers']) {
      const catalog = asRecord(await transport.request('GET', route, undefined, { directory }));
      const providers = catalog?.all ?? catalog?.providers;
      expect(providers).toEqual(expect.any(Array));
      if (!Array.isArray(providers)) throw new Error('Missing provider catalog');
      for (const id of ['opencode', 'opencode-go']) {
        const provider = providers.map(asRecord).find((entry) => entry?.id === id);
        expect(asRecord(provider?.models) ?? {}).not.toHaveProperty('free-fixture');
      }
    }
  });

  it('negotiates native decision and signed-out usage endpoints on 2.2.0', async (context) => {
    if (
      transport.version !== 2 ||
      compareVersions((await transport.readHealthInfo()).version ?? '0', '2.2.0') < 0
    )
      return context.skip();
    const before = modelRequests.length;
    const native = new NativeDecisions(
      { apiVersion: 2, request: transport.request.bind(transport) },
      () => ''
    );
    expect(await native.status()).toMatchObject({
      supported: true,
      model: null,
      models: expect.any(Array),
    });
    expect(
      await transport.request('GET', '/api/experimental/usage/limits', undefined, {
        directory: join(root, 'workspace'),
        maxResponseBytes: 1024 * 1024,
      })
    ).toEqual({ data: null, location: { directory: join(root, 'workspace') } });
    expect(modelRequests).toHaveLength(before);
  });

  it('does not restore configured non-chat models to modern chat catalogs', async (context) => {
    if (
      transport.version !== 2 ||
      compareVersions((await transport.readHealthInfo()).version ?? '0', '2.2.0') < 0
    )
      return context.skip();
    const directory = join(root, 'non-chat-models');
    await mkdir(directory);
    await writeFile(
      join(directory, 'opencode.json'),
      JSON.stringify({
        providers: {
          'non-chat-fixture': {
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only' },
            models: { picture: { type: 'image' }, reviewer: { type: 'decision' } },
          },
        },
      })
    );
    for (const route of ['/provider', '/config/providers']) {
      const catalog = asRecord(await transport.request('GET', route, undefined, { directory }));
      const providers = catalog?.all ?? catalog?.providers;
      if (!Array.isArray(providers)) throw new Error('Missing provider catalog');
      const provider = providers.map(asRecord).find((item) => item?.id === 'non-chat-fixture');
      expect(Object.keys(asRecord(provider?.models) ?? {})).toEqual([]);
    }
  });

  it('creates, updates, and reads a session through the common API', async () => {
    const session = asRecord(
      await transport.request('POST', '/session', {
        title: 'Adapter fixture',
        metadata: { varro: { permissionMode: 'default' } },
      })
    );
    expect(session?.directory).toBe(join(root, 'workspace'));
    sessionID = String(session?.id);
    const updated = asRecord(
      await transport.request('PATCH', `/session/${sessionID}`, {
        title: 'Adapter renamed',
        metadata: { varro: { permissionMode: 'full' } },
        permission: [{ permission: '*', pattern: '*', action: 'allow' }],
      })
    );
    expect(updated?.title).toBe('Adapter renamed');
    expect(updated?.metadata).toEqual({ varro: { permissionMode: 'full' } });
    expect(updated?.permission).toEqual([{ permission: '*', pattern: '*', action: 'allow' }]);
  }, 30000);

  it('archives and restores through native V2 state or the older-server annotation fallback', async (context) => {
    if (transport.version !== 2) return context.skip();
    const native = getOpenCodeApiCapabilities(
      await transport.request('GET', '/openapi.json')
    ).sessionArchiving;
    const created = asRecord(
      await transport.request('POST', '/session', { title: 'Archive parity fixture' })
    );
    if (!isString(created?.id)) throw new Error('Missing isolated archive fixture');
    const id = created.id;
    const beforeEvents = events.length;
    try {
      const archived = asRecord(
        await transport.request('PATCH', `/session/${id}`, { time: { archived: 123 } })
      );
      expect(asRecord(archived?.time)?.archived).toEqual(expect.any(Number));
      const canonical = asRecord(
        asRecord(await transport.request('GET', `/api/session/${id}`))?.data
      );
      expect(asRecord(canonical?.time)?.archived).toEqual(native ? expect.any(Number) : undefined);
      const included = await transport.request(
        'GET',
        '/experimental/session?archived=true&limit=1000'
      );
      expect(included).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id }),
          expect.objectContaining({ id: sessionID }),
        ])
      );
      if (native) {
        await vi.waitFor(
          () =>
            expect(events.slice(beforeEvents).map(parseServerEvent)).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: 'session.archived',
                  properties: expect.objectContaining({ sessionID: id }),
                }),
              ])
            ),
          { timeout: 5000 }
        );
        // Simulate another client restoring the session directly on the native API.
        await transport.request('PATCH', `/api/session/${id}`, { archived: false });
        await vi.waitFor(
          () =>
            expect(events.slice(beforeEvents).map(parseServerEvent)).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: 'session.unarchived',
                  properties: expect.objectContaining({ sessionID: id }),
                }),
              ])
            ),
          { timeout: 5000 }
        );
      } else {
        await transport.request('PATCH', `/session/${id}`, { time: { archived: null } });
      }
      const restored = asRecord(await transport.request('GET', `/session/${id}`));
      expect(asRecord(restored?.time)?.archived ?? undefined).toBeUndefined();
      await writeFile(
        join(root, 'archive-parity.json'),
        JSON.stringify({ native, archived, canonical, restored }, null, 2)
      );
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('keeps config-backed once approvals out of saved permissions and asks after config deletion', async (context) => {
    if (transport.version !== 2) return context.skip();
    const directory = join(root, 'workspace/permission-lifetime');
    const configDirectory = join(directory, '.opencode');
    const configPath = join(configDirectory, 'opencode.json');
    const options = { directory };
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(directory, 'opencode.json'),
      JSON.stringify({ permissions: [{ action: 'read', resource: '*', effect: 'ask' }] })
    );
    const sessions: string[] = [];
    const createSession = async () => {
      const session = asRecord(
        await transport.request(
          'POST',
          '/session',
          { title: 'Project approval lifetime', agent: 'build' },
          options
        )
      );
      if (!isString(session?.id)) throw new Error('Missing isolated permission lifetime session');
      sessions.push(session.id);
      return session.id;
    };
    const runRead = (id: string) =>
      transport.request(
        'POST',
        `/session/${id}/prompt_async`,
        {
          agent: 'build',
          model: { providerID: 'fixture', modelID: 'fixture' },
          parts: [{ type: 'text', text: 'RUN_READ_FIXTURE project approval lifetime' }],
        },
        options
      );
    const pendingRead = async (id: string) => {
      let request: UnknownRecord | undefined;
      await vi.waitFor(
        async () => {
          request = (
            (await transport.request('GET', '/permission', undefined, options)) as UnknownRecord[]
          ).find((entry) => entry.sessionID === id);
          expect(request?.permission).toBe('read');
        },
        { timeout: 10000 }
      );
      return request!;
    };
    const completedRead = (id: string) =>
      vi.waitFor(
        async () => {
          const messages = (await transport.request(
            'GET',
            `/session/${id}/message`,
            undefined,
            options
          )) as Array<{
            info: UnknownRecord;
            parts: UnknownRecord[];
          }>;
          expect(
            messages.some((message) =>
              message.parts.some(
                (part) =>
                  part.type === 'tool' &&
                  part.tool === 'read' &&
                  asRecord(part.state)?.status === 'completed'
              )
            )
          ).toBe(true);
          const status = asRecord(
            await transport.request('GET', '/session/status', undefined, options)
          )?.[id];
          expect(status === undefined || asRecord(status)?.type === 'idle').toBe(true);
        },
        { timeout: 10000 }
      );
    const saved = async () => {
      const values = asRecord(
        await transport.request('GET', '/api/permission/saved', undefined, options)
      )?.data;
      if (!Array.isArray(values)) throw new Error('Missing isolated saved-permission list');
      return values;
    };
    try {
      const first = await createSession();
      const savedBefore = await saved();
      await runRead(first);
      const pending = await pendingRead(first);
      if (!Array.isArray(pending.always) || pending.always.length === 0)
        throw new Error('Missing project approval patterns');
      await writeFile(
        configPath,
        JSON.stringify({
          permissions: pending.always.map((resource) => ({
            action: 'read',
            resource,
            effect: 'allow',
          })),
        })
      );
      await transport.request(
        'POST',
        `/permission/${pending.id}/reply`,
        { reply: 'once' },
        options
      );
      await completedRead(first);
      expect(await saved()).toEqual(savedBefore);

      // Reload only the isolated location to prove the standing grant comes from config.
      await transport.request('POST', '/instance/dispose', undefined, options);
      const second = await createSession();
      await runRead(second);
      await completedRead(second);
      expect(await saved()).toEqual(savedBefore);

      await unlink(configPath);
      await transport.request('POST', '/instance/dispose', undefined, options);
      const third = await createSession();
      await runRead(third);
      const afterDeletion = await pendingRead(third);
      await transport.request(
        'POST',
        `/permission/${afterDeletion.id}/reply`,
        { reply: 'once' },
        options
      );
      await completedRead(third);
      expect(await saved()).toEqual(savedBefore);
    } finally {
      for (const id of sessions) {
        await transport.request('POST', `/session/${id}/abort`, {}, options);
        await transport.request('DELETE', `/session/${id}`, undefined, options);
      }
    }
  }, 30000);

  it('loads and revokes URL-specific global config rules across projects without database grants', async (context) => {
    if (transport.version !== 2) return context.skip();
    const globalPath = join(root, 'config/opencode/opencode.json');
    const original = await readFile(globalPath, 'utf8');
    const config = asRecord(JSON.parse(original));
    const savedBefore = await transport.request('GET', '/api/permission/saved');
    const sessions: string[] = [];
    let expectedRules: PermissionRule[] = [
      { permission: 'webfetch', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: 'https://trusted.example/*', action: 'allow' },
    ];
    const askInProject = async (name: string, resource: string) => {
      const directory = join(root, 'workspace', `global-rule-${name}`);
      await mkdir(directory, { recursive: true });
      const git = spawnSync('git', ['init', '--quiet'], { cwd: directory });
      expect(git.status).toBe(0);
      const options = { directory };
      const session = asRecord(
        await transport.request(
          'POST',
          '/session',
          { title: `Global config ${name}`, agent: 'build' },
          options
        )
      );
      if (!isString(session?.id)) throw new Error('Missing global config fixture session');
      const id = session.id;
      sessions.push(id);
      // Catalogs can return before config plugins activate, including on the V2 floor.
      // Wait for the effective agent rules, then issue exactly one permission check.
      await expect
        .poll(
          async () => {
            const agents = await transport.request('GET', '/agent', undefined, options);
            if (!Array.isArray(agents)) throw new Error('Missing isolated agent catalog');
            const build = agents.map(asRecord).find((agent) => agent?.name === 'build');
            return Array.isArray(build?.permission)
              ? build.permission.map(asRecord).filter((rule) => rule?.permission === 'webfetch')
              : [];
          },
          { timeout: 5000 }
        )
        .toEqual(expectedRules);
      await writeFile(
        join(root, `global-rule-${name}.json`),
        JSON.stringify(
          {
            session,
            config: await transport.request('GET', '/config', undefined, options),
            agents: await transport.request('GET', '/agent', undefined, options),
          },
          null,
          2
        )
      );
      const result = asRecord(
        asRecord(
          await transport.request(
            'POST',
            `/api/session/${id}/permission`,
            { action: 'webfetch', resources: [resource], save: [resource] },
            options
          )
        )?.data
      );
      if (result?.effect === 'ask')
        await transport.request(
          'POST',
          `/permission/${result.id}/reply`,
          { reply: 'once' },
          options
        );
      return result?.effect;
    };
    try {
      await writeFile(
        globalPath,
        JSON.stringify({
          ...config,
          permissions: expectedRules.map((rule) => ({
            action: rule.permission,
            resource: rule.pattern,
            effect: rule.action,
          })),
        })
      );
      expect(await askInProject('one', 'https://trusted.example/one')).toBe('allow');
      expect(await askInProject('two', 'https://trusted.example/two')).toBe('allow');
      expect(await askInProject('other', 'https://other.example/')).toBe('ask');
      expectedRules = [{ permission: 'webfetch', pattern: '*', action: 'ask' }];
      await writeFile(
        globalPath,
        JSON.stringify({
          ...config,
          permissions: expectedRules.map((rule) => ({
            action: rule.permission,
            resource: rule.pattern,
            effect: rule.action,
          })),
        })
      );
      expect(await askInProject('revoked', 'https://trusted.example/revoked')).toBe('ask');
      expect(await transport.request('GET', '/api/permission/saved')).toEqual(savedBefore);
    } finally {
      await writeFile(globalPath, original);
      for (const id of sessions) await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('displays and revokes untracked saved approvals through the authenticated Varro host path', async (context) => {
    if (transport.version !== 2) return context.skip();
    expect(authorization).toBeTruthy();
    expect((await fetch(`${url}/api/permission/saved`)).status).toBe(401);
    const created = asRecord(
      await transport.request('POST', '/session', {
        title: 'Untracked saved approval fixture',
        permission: [{ permission: '*', pattern: '*', action: 'ask' }],
      })
    );
    if (!isString(created?.id)) throw new Error('Missing isolated saved-approval session');
    const id = created.id;
    const directory = join(root, 'workspace');
    const resource = 'printf varro-untracked-approval *';
    const ask = () =>
      transport.request('POST', `/api/session/${id}/permission`, {
        action: 'shell',
        resources: [resource],
        save: [resource],
      });
    const values = new Map<string, unknown>();
    const persistence = fixture<Persistence>({
      get: (key: string) => structuredClone(values.get(key)),
      set: (
        key: string,
        value: Array<{ server: string; rule: OpenCodeServerMemoryPermission }>
      ) => {
        values.set(key, structuredClone(value));
      },
      remove: (key: string) => {
        values.delete(key);
      },
    });
    let store = new ServerMemoryPermissionStore(persistence);
    const identity = `2:${url}`;
    const service = new OpenCodeConfigService(
      fixture<RestProxyCallbacks>({
        server: { apiVersion: 2, url },
        getServerMemoryPermissions: (projectID: string) => store.get(identity, projectID),
        rememberServerMemoryPermissions: (
          rules: Parameters<ServerMemoryPermissionStore['remember']>[1]
        ) => store.remember(identity, rules),
        forgetServerMemoryPermission: (
          rule: Parameters<ServerMemoryPermissionStore['forget']>[1]
        ) => store.forget(identity, rule),
      }),
      transport.request.bind(transport),
      () => directory
    );
    let savedID: string | undefined;
    try {
      const requested = asRecord(asRecord(await ask())?.data);
      expect(requested?.effect).toBe('ask');
      await transport.request('POST', `/permission/${requested?.id}/reply`, { reply: 'always' });
      const list = asRecord(await transport.request('GET', '/api/permission/saved'))?.data;
      if (!Array.isArray(list)) throw new Error('Missing isolated saved-approval list');
      const saved = list.map(asRecord).find((rule) => rule?.resource === resource);
      if (!isString(saved?.id) || !isString(saved.projectID))
        throw new Error('Missing isolated native approval');
      savedID = saved.id;
      expect(asRecord(asRecord(await ask())?.data)?.effect).toBe('allow');
      // Recreate the host with observations from a different connection identity.
      await store.remember('2:http://prior-connection', [
        { id: savedID, projectID: saved.projectID, permission: 'bash', pattern: resource },
      ]);
      store = new ServerMemoryPermissionStore(persistence);
      const panel = await service.readServerMemoryPermissions(id, directory);
      expect(panel).toMatchObject({
        supported: true,
        rules: [],
        untrackedRules: [expect.objectContaining({ id: savedID, pattern: resource })],
      });
      expect(store.get(identity, saved.projectID)).toEqual([]);
      const sessionBefore = asRecord(await transport.request('GET', `/session/${id}`));
      const configBefore = await readFile(join(directory, 'opencode.json'), 'utf8');
      const removed = await service.readServerMemoryPermissions(id, directory, {
        kind: 'remove',
        id: savedID,
      });
      expect(removed).toEqual({ supported: true, rules: [] });
      const native = asRecord(await transport.request('GET', '/api/permission/saved'))?.data;
      if (!Array.isArray(native)) throw new Error('Missing post-removal native snapshot');
      expect(native.map(asRecord).some((rule) => rule?.id === savedID)).toBe(false);
      expect(asRecord(await transport.request('GET', `/session/${id}`))?.permission).toEqual(
        sessionBefore?.permission
      );
      expect(await readFile(join(directory, 'opencode.json'), 'utf8')).toBe(configBefore);
      const afterRemoval = asRecord(asRecord(await ask())?.data);
      expect(afterRemoval?.effect).toBe('ask');
      await transport.request('POST', `/permission/${afterRemoval?.id}/reply`, { reply: 'once' });
      await writeFile(
        join(root, 'saved-approval-management.json'),
        JSON.stringify(
          { panel, removed, authenticationRequired: true, asksAfterRemoval: true },
          null,
          2
        )
      );
    } finally {
      if (savedID) await transport.request('DELETE', `/api/permission/saved/${savedID}`);
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('edits native saved permissions and rejects duplicate scopes', async (context) => {
    if (transport.version !== 2) return context.skip();
    if (
      !getOpenCodeApiCapabilities(await transport.request('GET', '/openapi.json'))
        .savedPermissionEditing
    )
      return context.skip();
    const created = asRecord(
      await transport.request('POST', '/session', {
        title: 'Saved permission edit fixture',
        permission: [{ permission: '*', pattern: '*', action: 'ask' }],
      })
    );
    if (!isString(created?.id)) throw new Error('Missing isolated saved-permission fixture');
    const id = created.id;
    const resources = ['varro saved edit fixture one', 'varro saved edit fixture two'];
    const savedIDs: string[] = [];
    try {
      for (const resource of resources) {
        const waiting = transport.request('POST', `/api/session/${id}/permission`, {
          action: 'shell',
          resources: [resource],
          save: [resource],
        });
        let requestID: string | undefined;
        await vi.waitFor(
          async () => {
            const pending = (await transport.request('GET', '/permission')) as UnknownRecord[];
            const request = pending.find((entry) => entry.sessionID === id);
            expect(request?.id).toEqual(expect.any(String));
            requestID = String(request?.id);
          },
          { timeout: 5000 }
        );
        await transport.request('POST', `/permission/${requestID}/reply`, { reply: 'always' });
        await waiting;
      }
      const saved = asRecord(await transport.request('GET', '/api/permission/saved'))
        ?.data as UnknownRecord[];
      for (const resource of resources) {
        const rule = saved.find(
          (entry) => entry.resource === resource && entry.projectID === created.projectID
        );
        if (!isString(rule?.id)) throw new Error('Missing saved fixture allowance');
        savedIDs.push(rule.id);
      }
      const response = await transport.request('PATCH', `/api/permission/saved/${savedIDs[0]}`, {
        resource: 'varro saved edit fixture narrowed',
      });
      expect(response).toMatchObject({
        data: { id: savedIDs[0], action: 'shell', resource: 'varro saved edit fixture narrowed' },
      });
      await expect(
        transport.request('PATCH', `/api/permission/saved/${savedIDs[0]}`, {
          resource: resources[1],
        })
      ).rejects.toThrow('409');
      await writeFile(join(root, 'saved-permission-edit.json'), JSON.stringify(response, null, 2));
    } finally {
      for (const savedID of savedIDs)
        await transport.request('DELETE', `/api/permission/saved/${savedID}`);
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('rejects new v1 share links but keeps local link cleanup available', async (context) => {
    const health = await transport.readHealthInfo();
    if (transport.version !== 1 || compareVersions(health.version ?? '0', '1.19.1') < 0)
      return context.skip();
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Share cleanup fixture' })
    );
    const id = String(session?.id);
    try {
      // The released HTTP handler masks the discontinued-sharing error as a generic 500.
      await expect(transport.request('POST', `/session/${id}/share`)).rejects.toThrow(
        '500 Internal Server Error'
      );
      const unchanged = asRecord(await transport.request('GET', `/session/${id}`));
      expect(unchanged?.share).toBeUndefined();
      const updated = asRecord(await transport.request('DELETE', `/session/${id}/share`));
      expect(updated?.id).toBe(id);
      expect(updated?.share).toBeUndefined();
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('answers the first Plan prompt without a separate reminder-only turn', async () => {
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Plan fixture' })
    );
    const id = String(session?.id);
    const start = providerPrompts.length;
    const text = 'Create a dummy plan. Reply with the fixture response without calling tools.';
    await transport.request('POST', `/session/${id}/prompt_async`, {
      agent: 'plan',
      model: { providerID: 'fixture', modelID: 'fixture' },
      parts: [{ type: 'text', text }],
    });
    await vi.waitFor(
      async () => {
        const messages = (await transport.request(
          'GET',
          `/session/${id}/message?limit=20`
        )) as Array<{
          info: UnknownRecord;
          parts: UnknownRecord[];
        }>;
        expect(
          messages.some(
            (message) =>
              message.info.role === 'user' && message.parts.some((part) => part.text === text)
          )
        ).toBe(true);
        expect(
          messages.some(
            (message) => message.info.role === 'assistant' && asRecord(message.info.time)?.completed
          )
        ).toBe(true);
        expect(asRecord(await transport.request('GET', '/session/status'))?.[id]).toBeUndefined();
      },
      { timeout: 45000, interval: 200 }
    );
    const prompts = providerPrompts.slice(start);
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain(text);
  }, 60000);

  it.skipIf(process.platform !== 'win32')(
    'loads instructions for a lowercase Windows drive',
    async () => {
      const directory = join(root, 'workspace').replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
      const session = asRecord(
        await transport.request(
          'POST',
          '/session',
          { title: 'Windows instructions fixture' },
          { directory }
        )
      );
      const id = String(session?.id);
      await transport.request(
        'POST',
        `/session/${id}/prompt_async`,
        {
          agent: 'build',
          model: { providerID: 'fixture', modelID: 'fixture' },
          parts: [{ type: 'text', text: 'Say the fixture response. Do not call tools.' }],
        },
        { directory }
      );
      await vi.waitFor(
        async () => {
          const messages = await transport.request(
            'GET',
            `/session/${id}/message?limit=20`,
            undefined,
            { directory }
          );
          expect(JSON.stringify(messages)).not.toContain('Instruction initialization blocked');
          expect(JSON.stringify(messages)).toContain('Adapter stream verified.');
        },
        { timeout: 15000, interval: 200 }
      );
    },
    30000
  );

  it('uses the current agent instructions after repeated Ask and Build turns', async () => {
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Agent switches' })
    );
    const id = String(session?.id);
    for (const [index, agent] of ['ask', 'build', 'ask', 'build'].entries()) {
      const marker = `AGENT_SWITCH_${index}`;
      const start = providerPrompts.length;
      await transport.request('POST', `/session/${id}/prompt_async`, {
        agent,
        system: `CURRENT_AGENT_FIXTURE: ${agent}`,
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: `${marker}: Say the fixture response.` }],
      });
      await vi.waitFor(
        async () => {
          const messages = await transport.request('GET', `/session/${id}/message`);
          expect(JSON.stringify(messages)).toContain(marker);
          const status = asRecord(await transport.request('GET', '/session/status'));
          expect(asRecord(status?.[id])?.type ?? 'idle').toBe('idle');
          expect(providerPrompts.length).toBeGreaterThan(start);
        },
        { timeout: 15000, interval: 100 }
      );
      const prompt = providerPrompts
        .slice(start)
        .find((messages) => JSON.stringify(messages).includes(marker));
      expect(prompt).toBeDefined();
      const system = prompt?.map(asRecord).filter((message) => message?.role === 'system');
      if (agent === 'ask') expect(JSON.stringify(system)).toContain('ASK_MODE_FIXTURE');
      else expect(JSON.stringify(system)).not.toContain('ASK_MODE_FIXTURE');
      // V2 keeps the original context for caching and appends a superseding system-update.
      // The latest mode declaration must match the admitted prompt on either backend.
      const declarations = JSON.stringify(prompt).match(/CURRENT_AGENT_FIXTURE: (ask|build)/g);
      expect(declarations?.at(-1)).toBe(`CURRENT_AGENT_FIXTURE: ${agent}`);
      const request = modelRequests
        .map(asRecord)
        .findLast(
          (value) => value?.stream === true && JSON.stringify(value.messages).includes(marker)
        );
      const tools = Array.isArray(request?.tools) ? request.tools.map(asRecord) : [];
      const canEdit = tools.some((tool) =>
        ['edit', 'write', 'patch', 'apply_patch'].includes(String(asRecord(tool?.function)?.name))
      );
      expect(canEdit).toBe(agent === 'build');
    }
  }, 60000);

  it('streams a real prompt and projects stable history', async () => {
    let release: (() => void) | undefined;
    streamGate = new Promise<void>((complete) => {
      release = complete;
    });
    try {
      await transport.request('POST', `/session/${sessionID}/prompt_async`, {
        agent: 'build',
        system: 'The VS Code workspace roots are /fixture/repo-a and /fixture/repo-b.',
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'Say the fixture response. Do not call tools.' }],
      });
      await vi.waitFor(async () =>
        expect(
          asRecord(asRecord(await transport.request('GET', '/session/status'))?.[sessionID])?.type
        ).toBe('busy')
      );
    } finally {
      release?.();
      streamGate = undefined;
    }
    let messages: Array<{ info: UnknownRecord; parts: UnknownRecord[] }> = [];
    await vi.waitFor(
      async () => {
        messages = (await transport.request(
          'GET',
          `/session/${sessionID}/message?limit=20`
        )) as typeof messages;
        expect(
          messages.some((message) =>
            message.parts.some((part) => part.text === 'Adapter stream verified.')
          )
        ).toBe(true);
        expect(
          messages.some(
            (message) => message.info.role === 'assistant' && asRecord(message.info.time)?.completed
          )
        ).toBe(true);
      },
      { timeout: 45000, interval: 200 }
    );
    const assistant = messages.find((message) => message.info.role === 'assistant')!;
    expect(JSON.stringify(modelRequests)).toContain(
      'The VS Code workspace roots are /fixture/repo-a and /fixture/repo-b.'
    );
    expect(assistant.info.modelID).toBe('fixture');
    const text = assistant.parts.find((part) => part.type === 'text')!;
    const delta = events
      .map(parseServerEvent)
      .find(
        (event) =>
          asRecord(event?.properties)?.textID === text.id ||
          asRecord(event?.properties)?.partID === text.id
      );
    expect(delta).toBeDefined();
    const page = asRecord(
      await transport.request('GET', `/session/${sessionID}/message?limit=1`, undefined, {
        captureNextCursor: true,
      })
    );
    expect(page?.data).toHaveLength(1);
    expect(page?.nextCursor).toBeTruthy();
    expect(
      asRecord(
        await transport.request(
          'GET',
          `/session/${sessionID}/message?limit=1&before=${encodeURIComponent(String(page?.nextCursor))}`,
          undefined,
          { captureNextCursor: true }
        )
      )?.data
    ).toHaveLength(1);
  }, 60000);

  it('streams and reconciles an actual tool execution in the fixture', async () => {
    await transport.request('POST', `/session/${sessionID}/prompt_async`, {
      model: { providerID: 'fixture', modelID: 'fixture' },
      parts: [{ type: 'text', text: 'RUN_READ_FIXTURE: read probe.txt with the read tool.' }],
    });
    await vi.waitFor(
      async () => {
        const messages = (await transport.request(
          'GET',
          `/session/${sessionID}/message`
        )) as Array<{ parts: UnknownRecord[] }>;
        const tool = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === 'tool' && asRecord(part.state)?.status === 'completed');
        expect(tool?.tool).toBe('read');
        expect(asRecord(tool?.state)?.output).toContain('isolated tool fixture');
        const matched = events
          .map(parseServerEvent)
          .some(
            (event) =>
              asRecord(event?.properties)?.callID === tool?.id ||
              asRecord(asRecord(event?.properties)?.part)?.id === tool?.id
          );
        expect(matched).toBe(true);
        const status = asRecord(await transport.request('GET', '/session/status'))?.[sessionID];
        expect(status === undefined || asRecord(status)?.type === 'idle').toBe(true);
      },
      { timeout: 30000, interval: 100 }
    );
  }, 45000);

  it('runs helper generation through the common message API', async () => {
    const result = asRecord(
      await transport.request('POST', `/session/${sessionID}/message`, {
        model: { providerID: 'fixture', modelID: 'fixture' },
        system: 'Return the fixture response.',
        parts: [{ type: 'text', text: 'Generate the response.' }],
      })
    );
    expect(
      (result?.parts as UnknownRecord[] | undefined)?.find((part) => part.type === 'text')?.text
    ).toBe('Adapter stream verified.');
  }, 30000);

  it('executes a configured slash command through the common API', async () => {
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Command fixture' })
    );
    const id = String(session?.id);
    try {
      const result = await transport.request('POST', `/session/${id}/command`, {
        command: 'fixture-note',
        arguments: '',
        agent: 'build',
        model: 'fixture/fixture',
      });
      if (transport.version === 2) expect(result).toBeUndefined();
      else expect(result).toMatchObject({ info: { role: 'assistant' }, parts: expect.any(Array) });
      await vi.waitFor(
        async () => {
          const messages = (await transport.request('GET', `/session/${id}/message`)) as Array<{
            info: UnknownRecord;
            parts: UnknownRecord[];
          }>;
          expect(messages.some((message) => message.info.role === 'user')).toBe(true);
          expect(
            messages.some(
              (message) =>
                message.info.role === 'assistant' &&
                asRecord(message.info.time)?.completed &&
                message.parts.some((part) => part.text === 'Adapter stream verified.')
            )
          ).toBe(true);
        },
        { timeout: 30000 }
      );
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 45000);

  it('delegates a native command once with arguments and attachments while preserving the parent model', async (context) => {
    if (transport.version !== 2) {
      context.skip();
      return;
    }
    const parent = asRecord(
      await transport.request('POST', '/session', { title: 'Delegated command fixture' })
    );
    const id = String(parent?.id);
    let childID: string | undefined;
    try {
      await transport.request('POST', `/api/session/${id}/model`, {
        model: { providerID: 'fixture', id: 'fixture' },
      });
      const before = asRecord(await transport.request('GET', `/session/${id}`));
      const catalog = (await transport.request('GET', '/command')) as UnknownRecord[];
      expect(catalog.find((entry) => entry.name === 'fixture-audit')).toEqual({
        name: 'fixture-audit',
        description: 'Audit fixture',
        source: 'command',
        template: '',
        hints: [],
      });
      await transport.request('POST', `/session/${id}/command`, {
        command: 'fixture-audit',
        arguments: 'src/auth "error handling"',
        parts: [
          {
            type: 'file',
            mime: 'text/plain',
            filename: 'context.txt',
            url: 'data:text/plain;base64,Y29udGV4dA==',
          },
        ],
      });
      await vi.waitFor(
        async () => {
          const children = (await transport.request(
            'GET',
            `/session/${id}/children`
          )) as UnknownRecord[];
          expect(children).toHaveLength(1);
          childID = String(children[0]?.id);
          expect(children[0]).toMatchObject({
            parentID: id,
            agent: 'general',
            model: { providerID: 'fixture', modelID: 'fixture-command' },
          });
          const messages = (await transport.request(
            'GET',
            `/session/${id}/message`
          )) as MessageEntry[];
          const results = messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === 'text' && part.subagentResult);
          expect(results).toHaveLength(1);
          expect(results[0]).toMatchObject({
            subagentResult: { sessionID: childID, state: 'completed', agent: 'general' },
          });
        },
        { timeout: 30000 }
      );
      const childMessages = (await transport.request(
        'GET',
        `/session/${childID}/message`
      )) as MessageEntry[];
      const childPrompt = childMessages.find((message) => message.info.role === 'user');
      expect(childPrompt?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Audit src/auth "error handling". Do not call tools.'),
          }),
          expect.objectContaining({ type: 'file', filename: 'context.txt' }),
        ])
      );
      const after = asRecord(await transport.request('GET', `/session/${id}`));
      expect(after?.model).toEqual(before?.model);
      expect(after?.agent).toBe(before?.agent);
      const recovered = (await transport.request(
        'GET',
        `/session/${id}/message`
      )) as MessageEntry[];
      const resultParts = recovered
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'text' && part.subagentResult);
      expect(resultParts).toHaveLength(1);
    } finally {
      if (childID) await transport.request('DELETE', `/session/${childID}`);
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 45000);

  it.for(['launch', 'child'] as const)(
    'attributes a native command %s failure to the correct session',
    { timeout: 45000 },
    async (phase, context) => {
      if (transport.version !== 2) {
        context.skip();
        return;
      }
      const parent = asRecord(
        await transport.request('POST', '/session', { title: `${phase} failure fixture` })
      );
      const id = String(parent?.id);
      let childID: string | undefined;
      try {
        if (phase === 'launch') {
          await expect(
            transport.request('POST', `/session/${id}/command`, {
              command: 'fixture-launch-error',
              arguments: '',
              model: 'fixture/fixture',
            })
          ).rejects.toThrow('Agent not found');
          expect(await transport.request('GET', `/session/${id}/children`)).toEqual([]);
          return;
        }
        await transport.request('POST', `/session/${id}/command`, {
          command: `fixture-${phase}-error`,
          arguments: '',
          model: 'fixture/fixture',
        });
        await vi.waitFor(
          async () => {
            const children = (await transport.request(
              'GET',
              `/session/${id}/children`
            )) as UnknownRecord[];
            expect(children).toHaveLength(1);
            childID = String(children[0]?.id);
            const messages = (await transport.request(
              'GET',
              `/session/${id}/message`
            )) as MessageEntry[];
            const results = messages
              .flatMap((message) => message.parts)
              .filter((part) => part.type === 'text' && part.subagentResult);
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
              subagentResult: { sessionID: childID, state: 'error' },
            });
          },
          { timeout: 30000 }
        );
      } finally {
        if (childID) await transport.request('DELETE', `/session/${childID}`);
        await transport.request('DELETE', `/session/${id}`);
      }
    }
  );

  it('attaches a selected skill to a v2 prompt without exposing generated instructions', async () => {
    if (transport.version !== 2) return;
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Selected skill fixture' })
    );
    const id = String(session?.id);
    const text = 'Use $[fixture-skill] for this reply.';
    const before = providerPrompts.length;
    try {
      await transport.request('POST', `/session/${id}/message`, {
        parts: [
          { type: 'text', text },
          { type: 'text', text: formatSkillAttachment('fixture-skill') },
        ],
        agent: 'build',
        model: { providerID: 'fixture', modelID: 'fixture' },
      });
      const messages = (await transport.request('GET', `/session/${id}/message`)) as Array<{
        info: UnknownRecord;
        parts: UnknownRecord[];
      }>;
      const user = messages.find((message) => message.info.role === 'user');
      expect(user?.parts[0]?.text).toBe(text);
      expect(user?.parts.slice(1).map((part) => parseSkillAttachment(String(part.text)))).toEqual([
        'fixture-skill',
      ]);
      const userPrompts = providerPrompts
        .slice(before)
        .flat()
        .map(asRecord)
        .filter((message) => message?.role === 'user');
      expect(JSON.stringify(userPrompts)).toContain(
        'Reply with the fixture response. Do not call tools.'
      );
      expect(JSON.stringify(userPrompts)).not.toContain('[Attached skill:');
      expect(JSON.stringify(userPrompts)).not.toContain('Use the skill tool');
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 45000);

  it('lists and runs a skill slash command with arguments', async () => {
    await vi.waitFor(
      async () =>
        expect(await transport.request('GET', '/skill')).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })])
        ),
      { timeout: 5000 }
    );
    const commands = (await transport.request('GET', '/command')) as UnknownRecord[];
    expect(commands.find((command) => command.name === 'fixture-skill')).toMatchObject({
      source: 'skill',
    });
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Skill command fixture' })
    );
    const id = String(session?.id);
    const before = providerPrompts.length;
    try {
      await transport.request('POST', `/session/${id}/command`, {
        command: 'fixture-skill',
        arguments: 'SKILL_ARGUMENT_FIXTURE',
        agent: 'build',
        model: 'fixture/fixture',
      });
      await vi.waitFor(
        async () => {
          const status = asRecord(await transport.request('GET', '/session/status'))?.[id];
          expect(status === undefined || asRecord(status)?.type === 'idle').toBe(true);
          const messages = (await transport.request('GET', `/session/${id}/message`)) as Array<{
            info: UnknownRecord;
            parts: UnknownRecord[];
          }>;
          expect(JSON.stringify(messages)).toContain('Adapter stream verified.');
          expect(JSON.stringify(providerPrompts.slice(before))).toContain('SKILL_ARGUMENT_FIXTURE');
          if (transport.version === 2) {
            const user = messages.find((message) => message.info.role === 'user');
            expect(user?.parts[0]?.text).toBe('SKILL_ARGUMENT_FIXTURE');
            expect(
              user?.parts.slice(1).map((part) => parseSkillAttachment(String(part.text)))
            ).toEqual(['fixture-skill']);
            expect(messages.filter((message) => message.info.role === 'assistant')).toHaveLength(1);
            expect(
              messages.flatMap((message) => message.parts).some((part) => part.tool === 'skill')
            ).toBe(false);
            expect(JSON.stringify(providerPrompts.slice(before))).toContain(
              'Reply with the fixture response. Do not call tools.'
            );
          }
        },
        { timeout: 30000 }
      );
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 45000);

  it('compacts with the selected model through the common API', async () => {
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Compaction fixture' })
    );
    const id = String(session?.id);
    try {
      await transport.request('POST', `/session/${id}/message`, {
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'Reply before compaction. Do not call tools.' }],
      });
      if (transport.version === 2) {
        await transport.request('POST', `/api/session/${id}/model`, {
          model: { providerID: 'missing', id: 'previous-model' },
        });
      }
      const before = modelRequests.length;
      expect(
        await transport.request('POST', `/session/${id}/summarize`, {
          providerID: 'fixture',
          modelID: 'fixture',
        })
      ).toBe(true);
      await vi.waitFor(
        async () => {
          expect(modelRequests.length).toBeGreaterThan(before);
          const status = asRecord(await transport.request('GET', '/session/status'))?.[id];
          expect(status === undefined || asRecord(status)?.type === 'idle').toBe(true);
          const messages = await transport.request('GET', `/session/${id}/message`);
          expect(JSON.stringify(messages)).toContain('Adapter stream verified.');
          expect(JSON.stringify(messages)).not.toContain('Model not found');
        },
        { timeout: 30000 }
      );
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 45000);

  it.each([0, 75, 250])(
    'preserves pending steering and interruption history after cancelling a stalled turn with %sms sampling delay',
    async (samplingDelay) => {
      if (transport.version !== 2) return;
      const session = asRecord(
        await transport.request('POST', '/session', { title: 'Pending steering abort fixture' })
      );
      if (!isString(session?.id)) throw new Error('Missing steering abort fixture session');
      const id = session.id;
      const start = modelRequests.length;
      let release: (() => void) | undefined;
      streamGate = new Promise<void>((complete) => {
        release = complete;
      });
      try {
        await transport.request('POST', `/session/${id}/prompt_async`, {
          model: { providerID: 'fixture', modelID: 'fixture' },
          parts: [{ type: 'text', text: 'Wait for cancellation.' }],
        });
        await vi.waitFor(() => expect(modelRequests.length).toBeGreaterThan(start), {
          timeout: 10000,
        });
        await transport.request('POST', `/session/${id}/prompt_async`, {
          messageID: 'msg_pending_steer',
          delivery: 'steer',
          parts: [{ type: 'text', text: 'Keep this steering prompt pending.' }],
        });
        expect(await transport.request('GET', `/session/${id}/message`)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              info: expect.objectContaining({ id: 'msg_pending_steer', pendingDelivery: 'steer' }),
            }),
          ])
        );
        await transport.request('POST', `/session/${id}/abort`);
        await vi.waitFor(
          async () => {
            expect(await transport.request('GET', `/session/${id}/message`)).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  info: expect.objectContaining({
                    role: 'assistant',
                    // Snapshot capture overlaps the provider request from v2.0.26, so
                    // cancellation can project an interrupted idle record before a step starts.
                    error: expect.objectContaining({
                      name: expect.stringMatching(/^(aborted|MessageAbortedError)$/),
                    }),
                  }),
                }),
                expect.objectContaining({
                  info: expect.objectContaining({
                    id: 'msg_pending_steer',
                    pendingDelivery: 'steer',
                  }),
                }),
              ])
            );
          },
          { timeout: 10000 }
        );
        await vi.waitFor(() =>
          expect(
            events.some((event) => {
              const parsed = parseServerEvent(event);
              return (
                parsed?.type === 'session.error' &&
                parsed.properties?.sessionID === id &&
                asRecord(parsed.properties.error)?.name === 'MessageAbortedError'
              );
            })
          ).toBe(true)
        );
        release?.();
        streamGate = undefined;
        await transport.request('POST', `/api/session/${id}/prompt`, {
          id: 'msg_still_queued',
          text: 'This queued prompt must stay parked.',
          delivery: 'queue',
          resume: false,
        });
        expect(await transport.request('POST', `/session/${id}/resume-steering`)).toBe(true);
        await vi.waitFor(
          async () => {
            const status = asRecord(await transport.request('GET', '/session/status'))?.[id];
            expect(status === undefined || asRecord(status)?.type === 'idle').toBe(true);
            const messages = await transport.request('GET', `/session/${id}/message`);
            expect(messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  parts: expect.arrayContaining([
                    expect.objectContaining({ text: 'Adapter stream verified.' }),
                  ]),
                }),
              ])
            );
          },
          { timeout: 10000 }
        );
        await new Promise<void>((done) => setTimeout(done, samplingDelay));
        await vi.waitFor(
          async () => {
            const messages = (await transport.request('GET', `/session/${id}/message`)) as Array<{
              info: UnknownRecord;
              parts: UnknownRecord[];
            }>;
            const steering = messages.find((message) => message.info.id === 'msg_pending_steer');
            expect(steering?.info.pendingDelivery).toBeUndefined();
            expect(
              messages.filter(
                (message) => message.info.role === 'user' && !message.info.pendingDelivery
              )
            ).toHaveLength(2);
            expect(
              messages.find((message) => message.info.id === 'msg_still_queued')?.info
                .pendingDelivery
            ).toBe('queue');
            expect(
              messages.some((message) =>
                message.parts.some((part) => part.text === 'Adapter stream verified.')
              )
            ).toBe(true);
          },
          { timeout: 10000 }
        );
      } finally {
        release?.();
        streamGate = undefined;
        await transport.request('POST', `/session/${id}/abort`);
        await transport.request('DELETE', `/session/${id}`);
      }
    },
    25000
  );

  it('aborts an active provider request and accepts the next prompt', async () => {
    const session = asRecord(
      await transport.request('POST', '/session', { title: 'Abort fixture' })
    );
    const id = String(session?.id);
    const start = modelRequests.length;
    let release: (() => void) | undefined;
    streamGate = new Promise<void>((complete) => {
      release = complete;
    });
    try {
      await transport.request('POST', `/session/${id}/prompt_async`, {
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'Wait for cancellation.' }],
      });
      await vi.waitFor(() => expect(modelRequests.length).toBeGreaterThan(start), {
        timeout: 30000,
      });
      expect(await transport.request('POST', `/session/${id}/abort`, {})).toBe(true);
      await vi.waitFor(async () => {
        const status = asRecord(await transport.request('GET', '/session/status'))?.[id];
        expect(status === undefined || asRecord(status)?.type === 'idle').toBe(true);
      });
      release?.();
      streamGate = undefined;
      await transport.request('POST', `/session/${id}/prompt_async`, {
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'Reply after cancellation.' }],
      });
      await vi.waitFor(
        async () => {
          const messages = (await transport.request('GET', `/session/${id}/message`)) as Array<{
            info: UnknownRecord;
            parts: UnknownRecord[];
          }>;
          const last = messages.at(-1);
          expect(last?.info.role).toBe('assistant');
          expect(asRecord(last?.info.time)?.completed).toBeTruthy();
          expect(last?.parts.some((part) => part.text === 'Adapter stream verified.')).toBe(true);
          expect(messages.filter((message) => message.info.role === 'user')).toHaveLength(2);
        },
        { timeout: 30000 }
      );
    } finally {
      release?.();
      streamGate = undefined;
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 45000);

  it('keeps full-access approval session-scoped and asks again after reset', async (context) => {
    if (!(await transport.readHealthInfo()).version?.startsWith('2.')) {
      context.skip();
      return;
    }
    const session = asRecord(
      await transport.request('POST', '/session', {
        title: 'Permission reset fixture',
        permission: [{ permission: 'read', pattern: '*', action: 'ask' }],
      })
    );
    const id = String(session?.id);
    try {
      await transport.request('POST', `/session/${id}/prompt_async`, {
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'RUN_READ_FIXTURE allowed' }],
      });
      let initial: UnknownRecord | undefined;
      await vi.waitFor(
        async () => {
          initial = ((await transport.request('GET', '/permission')) as UnknownRecord[]).find(
            (request) => request.sessionID === id
          );
          expect(initial?.permission).toBe('read');
        },
        { timeout: 10000 }
      );
      await transport.request('PATCH', `/session/${id}`, {
        permission: [{ permission: '*', pattern: '*', action: 'allow' }],
      });
      await transport.request('POST', `/permission/${initial?.id}/reply`, { reply: 'once' });
      expect(asRecord(await transport.request('GET', '/api/permission/saved'))?.data).toEqual([]);
      await vi.waitFor(
        async () => {
          const status = asRecord(await transport.request('GET', '/session/status'))?.[id];
          expect(status === undefined || asRecord(status)?.type === 'idle').toBe(true);
        },
        { timeout: 10000 }
      );
      await transport.request('PATCH', `/session/${id}`, {
        permission: [{ permission: 'read', pattern: '*', action: 'ask' }],
      });
      await transport.request('POST', `/session/${id}/prompt_async`, {
        model: { providerID: 'fixture', modelID: 'fixture' },
        parts: [{ type: 'text', text: 'RUN_READ_FIXTURE must ask again' }],
      });
      let pending: UnknownRecord | undefined;
      await vi.waitFor(
        async () => {
          pending = ((await transport.request('GET', '/permission')) as UnknownRecord[]).find(
            (request) => request.sessionID === id
          );
          expect(pending?.permission).toBe('read');
        },
        { timeout: 10000 }
      );
      await transport.request('POST', `/permission/${pending?.id}/reply`, { reply: 'once' });
    } finally {
      await transport.request('POST', `/session/${id}/abort`, {});
      await transport.request('DELETE', `/session/${id}`);
    }
  }, 30000);

  it('keeps native permission and form requests actionable through acknowledgement', async (context) => {
    const health = await transport.readHealthInfo();
    if (!health.version?.startsWith('2.')) {
      context.skip();
      return;
    }
    await transport.request('PATCH', `/session/${sessionID}`, {
      permission: [{ permission: '*', pattern: '*', action: 'ask' }],
    });
    const waiting = transport.request('POST', `/api/session/${sessionID}/permission`, {
      action: 'shell',
      resources: ['fixture permission only'],
      save: ['fixture permission only'],
      metadata: {},
    });
    let permission: UnknownRecord | undefined;
    await vi.waitFor(async () => {
      const pending = (await transport.request('GET', '/permission')) as UnknownRecord[];
      permission = pending.find((request) => request.sessionID === sessionID);
      expect(permission?.permission).toBe('bash');
    });
    expect(
      await transport.request('POST', `/permission/${permission?.id}/reply`, { reply: 'once' })
    ).toBe(true);
    expect(asRecord(asRecord(await waiting)?.data)?.effect).toBe('ask');
    expect(await transport.request('GET', '/permission')).toEqual([]);
    // Session-scoped Always uses a session rule plus a once reply, not the
    // server's project-scoped native Always decision.
    await transport.request('PATCH', `/session/${sessionID}`, {
      permission: [{ permission: 'bash', pattern: 'fixture permission only', action: 'allow' }],
    });
    expect(asRecord(await transport.request('GET', `/session/${sessionID}`))?.permission).toEqual([
      { permission: 'bash', pattern: 'fixture permission only', action: 'allow' },
    ]);
    const repeated = await transport.request('POST', `/api/session/${sessionID}/permission`, {
      action: 'shell',
      resources: ['fixture permission only'],
      save: ['fixture permission only'],
      metadata: {},
    });
    expect(asRecord(asRecord(repeated)?.data)?.effect).toBe('allow');
    expect(await transport.request('GET', '/permission')).toEqual([]);
    const form = asRecord(
      asRecord(
        await transport.request('POST', `/api/session/${sessionID}/form`, {
          title: 'Fixture question',
          fields: [
            {
              key: 'choice',
              type: 'string',
              title: 'Choose',
              options: [{ value: 'accepted', label: 'Accept' }],
            },
          ],
        })
      )?.data
    );
    expect(form?.id).toBeTruthy();
    const pending = (await transport.request('GET', '/question')) as UnknownRecord[];
    expect(pending.find((request) => request.id === form?.id)).toMatchObject({
      kind: 'native-form',
      sessionID,
      form: {
        fields: [
          {
            key: 'choice',
            type: 'string',
            options: [{ value: 'accepted', label: 'Accept' }],
          },
        ],
      },
    });
    await expect(
      transport.request('POST', `/question/${form?.id}/reply`, { answers: [['Accept']] })
    ).rejects.toThrow('Native forms require keyed, typed answers');
    expect(
      ((await transport.request('GET', '/question')) as UnknownRecord[]).some(
        (request) => request.id === form?.id
      )
    ).toBe(true);
    expect(
      await transport.request('POST', `/question/${form?.id}/reply`, {
        kind: 'native-form',
        sessionID,
        answer: { choice: 'accepted' },
      })
    ).toBe(true);
    expect(await transport.request('GET', '/question')).toEqual([]);
    const cancelled = asRecord(
      asRecord(
        await transport.request('POST', `/api/session/${sessionID}/form`, {
          title: 'Cancel fixture',
          fields: [{ key: 'text', type: 'string' }],
        })
      )?.data
    );
    expect(await transport.request('POST', `/question/${cancelled?.id}/reject`, {})).toBe(true);
    expect(await transport.request('GET', '/question')).toEqual([]);
  }, 30000);

  it('retains a pre-turn failure as an assistant error instead of an empty transcript', async (context) => {
    if (!(await transport.readHealthInfo()).version?.startsWith('2.')) {
      context.skip();
      return;
    }
    const created = asRecord(
      await transport.request('POST', '/session', { title: 'Adapter preflight failure' })
    );
    const id = String(created?.id);
    try {
      await transport.request('POST', `/session/${id}/prompt_async`, {
        agent: 'build',
        model: { providerID: 'missing', modelID: 'missing' },
        parts: [{ type: 'text', text: 'Preflight failure fixture' }],
      });
      await vi.waitFor(
        async () => {
          const messages = (await transport.request('GET', `/session/${id}/message`)) as Array<{
            info: UnknownRecord;
            parts: UnknownRecord[];
          }>;
          expect(messages).toHaveLength(2);
          expect(messages[0]?.info.role).toBe('user');
          expect(messages[1]?.info.role).toBe('assistant');
          expect(messages[1]?.info.error).toBeTruthy();
        },
        { timeout: 10000 }
      );
      expect(
        events
          .map(parseServerEvent)
          .some(
            (event) =>
              event?.type === 'session.next.step.started' &&
              asRecord(event.properties)?.sessionID === id
          )
      ).toBe(false);
    } finally {
      await transport.request('DELETE', `/session/${id}`);
    }
  });

  it('forks, stages and clears a revert, then deletes test sessions', async () => {
    const messages = (await transport.request('GET', `/session/${sessionID}/message`)) as Array<{
      info: UnknownRecord;
    }>;
    const user = messages.find((message) => message.info.role === 'user')!;
    const fork = asRecord(await transport.request('POST', `/session/${sessionID}/fork`, {}));
    expect(fork?.id).toBeTruthy();
    const forkMessages = (await transport.request('GET', `/session/${fork?.id}/message`)) as Array<{
      info: UnknownRecord;
    }>;
    const tail = forkMessages.at(-1)!;
    expect(await transport.request('DELETE', `/session/${fork?.id}/message/${tail.info.id}`)).toBe(
      true
    );
    await transport.request('POST', `/session/${sessionID}/revert`, { messageID: user.info.id });
    expect(
      asRecord(asRecord(await transport.request('GET', `/session/${sessionID}`))?.revert)?.messageID
    ).toBe(user.info.id);
    await transport.request('POST', `/session/${sessionID}/unrevert`, {});
    expect(
      asRecord(await transport.request('GET', `/session/${sessionID}`))?.revert
    ).toBeUndefined();
    expect(await transport.request('DELETE', `/session/${fork?.id}`)).toBe(true);
    expect(await transport.request('DELETE', `/session/${sessionID}`)).toBe(true);
  }, 30000);
});
