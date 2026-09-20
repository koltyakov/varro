/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion -- The VS Code logger is mocked; all OpenCode requests use an isolated real server. Assertions narrow fixture response shapes. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { asRecord, isString, type UnknownRecord } from '../shared/type-utils';
import { parseServerEvent } from '../shared/protocol';
import { parseHealthResponse } from '../shared/health';
import { OpenCodeTransport } from './open-code-transport';
import { basicAuthorization, OpenCodeStartupOutput } from './opencode-connection';

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

  beforeAll(async () => {
    const parent = resolve('artifacts/ai-test-data');
    await mkdir(parent, { recursive: true });
    root = await mkdtemp(join(parent, 'adapter-'));
    for (const name of ['home', 'data', 'config', 'state', 'cache', 'workspace'])
      await mkdir(join(root, name));
    const git = spawnSync('git', ['init', '--quiet'], { cwd: join(root, 'workspace') });
    if (git.status !== 0) throw new Error('Could not initialize isolated fixture repository');
    await writeFile(join(root, 'workspace/probe.txt'), 'isolated tool fixture\n');
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
    await new Promise<void>((done) => modelServer.listen(0, '127.0.0.1', done));
    const address = modelServer.address();
    if (!address || isString(address)) throw new Error('Fixture server did not bind');
    await writeFile(
      join(root, 'workspace/opencode.json'),
      JSON.stringify({
        model: 'fixture/fixture',
        command: { 'fixture-note': { template: 'Reply with the fixture response.' } },
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
    const output = new OpenCodeStartupOutput((password) => {
      authorization = basicAuthorization(password);
    });
    let logs = '';
    child = crossSpawn(binary!, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: join(root, 'workspace'),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_STATE_HOME: join(root, 'state'),
        XDG_CACHE_HOME: join(root, 'cache'),
        OPENCODE_DB: join(root, 'data/probe.db'),
        OPENCODE_TEST_HOME: join(root, 'home'),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
      },
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
    await new Promise<void>((done) => (modelServer ? modelServer.close(() => done()) : done()));
    if (root) await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
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
      await transport.request('POST', `/session/${id}/command`, {
        command: 'fixture-note',
        arguments: '',
        agent: 'build',
        model: 'fixture/fixture',
      });
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
