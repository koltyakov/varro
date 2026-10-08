/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- The VS Code logger is mocked; all OpenCode requests use an isolated real server. Assertions narrow fixture response shapes. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { asRecord, isString, type UnknownRecord } from '../shared/type-utils';
import { parseServerEvent } from '../shared/protocol';
import { parseHealthResponse } from '../shared/health';
import { OpenCodeTransport } from './open-code-transport';
import { compareVersions } from './server-utils';
import { basicAuthorization, OpenCodeStartupOutput } from './opencode-connection';
import { tryGenerateOneShot } from './one-shot-generation';
import { SessionExportService } from './session-export-service';
import { getAssistantDialogSummaryMap } from '../webview/components/message-list/assistant-dialog';
import type { MessageEntry } from '../webview/types';
import { logger } from './logger';
import { readLocalSessionSummary } from './local-session-summary';
import { sessionSummary } from './session-summary';
import { formatSkillAttachment, parseSkillAttachment } from '../shared/skill-reference';

const exportEditor = vi.hoisted(() => ({
  openTextDocument: vi.fn(async (options: { content: string; language: string }) => options),
  showTextDocument: vi.fn(),
  showErrorMessage: vi.fn(),
}));
vi.mock('vscode', () => ({
  workspace: { openTextDocument: exportEditor.openTextDocument },
  window: {
    showTextDocument: exportEditor.showTextDocument,
    showErrorMessage: exportEditor.showErrorMessage,
  },
}));

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const binary = process.env.VARRO_OPENCODE_TEST_BINARY;

describe.skipIf(!binary)('released OpenCode adapter contract', () => {
  let child: ChildProcess;
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
              models: { fixture: { name: 'Fixture', limit: { context: 32000, output: 1000 } } },
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
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        providers: { openai: { settings: { chunkTimeout: 300000 } } },
      });
    }
    child = crossSpawn(binary!, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: join(root, 'workspace'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    if (process.env.VARRO_OPENCODE_TEST_VERSION)
      expect((await transport.readHealthInfo()).version).toBe(
        process.env.VARRO_OPENCODE_TEST_VERSION
      );
    void transport.startEventStream();
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  }, 60000);

  afterAll(async () => {
    transport?.stopEventStream();
    transport?.abortRequests();
    child?.kill('SIGTERM');
    if (child) await Promise.race([new Promise((done) => child.once('exit', done)), delay(3000)]);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    modelServer?.closeAllConnections();
    for (const socket of silentSockets) socket.destroy();
    await new Promise<void>((done) => (modelServer ? modelServer.close(() => done()) : done()));
    if (root) await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
  });

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

  it('falls back for a configured custom model without admitting duplicate generation', async () => {
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
    // The released base runner does not resolve this configured provider, even
    // though location-scoped catalogs and helper sessions can use it.
    expect(result).toBeNull();
    expect(modelRequests).toHaveLength(requestCount);
    expect(await transport.request('GET', '/session')).toEqual(before);
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
    const commands = (await transport.request('GET', '/command')) as UnknownRecord[];
    const command = commands.find((entry) => entry.name === 'fixture-note');
    expect(command).toBeDefined();
    expect(isString(command?.description || command?.template)).toBe(true);
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

  it('preserves pending steering and interruption history after cancelling a stalled turn', async () => {
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
            messages.find((message) => message.info.id === 'msg_still_queued')?.info.pendingDelivery
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
  }, 25000);

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
    expect(pending.some((request) => request.id === form?.id)).toBe(true);
    expect(
      await transport.request('POST', `/question/${form?.id}/reply`, { answers: [['Accept']] })
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
