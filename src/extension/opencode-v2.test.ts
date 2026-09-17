/* oxlint-disable anti-slop/no-module-mocking -- Tests exercise HTTP boundaries with deterministic wire responses and typed fixture assertions. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ModelInfo, SessionMessageAssistant, SessionInfo } from '@opencode/client';
import { OpenCodeStartupOutput, openCodeApiVersion } from './opencode-connection';
import {
  projectV2Message,
  projectV2Model,
  projectV2Permission,
  v2Action,
  v2Rules,
} from './opencode-v2-projection';
import { projectV2Event } from './opencode-v2-events';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';
import { OpenCodeTransport } from './open-code-transport';
import { asRecord } from '../shared/type-utils';
import { parseServerEvent } from '../shared/protocol';
import { parseHealthResponse } from '../shared/health';
import { normalizeRecycleBinSession } from '../shared/recycle-bin';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

describe('v2 prompt delivery', () => {
  it.each([
    [undefined, 'steer'],
    ['steer', 'steer'],
    ['queue', 'queue'],
  ])('maps %s delivery to %s', async (delivery, expected) => {
    const wire = vi.fn(async () => ({ data: { id: 'ses_delivery' } }));
    const adapter = new OpenCodeV2Adapter(wire);
    await adapter.request('POST', '/session/ses_delivery/prompt_async', {
      delivery,
      parts: [{ type: 'text', text: 'Create a plan' }],
    });
    expect(wire).toHaveBeenLastCalledWith(
      'POST',
      '/api/session/ses_delivery/prompt',
      expect.objectContaining({ text: 'Create a plan', delivery: expected }),
      expect.anything()
    );
  });
});

describe('v2 session system instructions', () => {
  it.each(['prompt_async', 'prompt', 'message', 'command'])(
    'saves updated workspace instructions before submitting %s',
    async (action) => {
      const calls: Array<{ method: string; path: string; body: unknown }> = [];
      const adapter = new OpenCodeV2Adapter(async (method, path, body) => {
        calls.push({ method, path, body });
        return { data: { id: 'ses_workspace' } };
      });
      // The message route with a system prompt is reserved for one-shot generation.
      if (action === 'message') {
        await adapter.request('POST', '/session/ses_workspace/message', {
          system: 'Generate a title',
          parts: [{ type: 'text', text: 'Title this session' }],
        });
        expect(calls).toEqual([
          {
            method: 'POST',
            path: '/api/session/ses_workspace/generate',
            body: { prompt: 'Generate a title\n\nTitle this session' },
          },
        ]);
        return;
      }
      for (const system of ['Workspace roots: /repo-a, /repo-b', 'Workspace roots: /repo-b']) {
        calls.length = 0;
        await adapter.request('POST', `/session/ses_workspace/${action}`, {
          system,
          command: 'review',
          noReply: true,
          parts: [{ type: 'text', text: 'What folders are in the workspace?' }],
        });
        expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
          'GET /api/session/ses_workspace',
          'PUT /api/experimental/session/ses_workspace/instructions/entries/varro.system',
          `POST /api/session/ses_workspace/${action === 'command' ? 'command' : 'prompt'}`,
        ]);
        expect(calls[1]?.body).toEqual({ value: system });
        expect(calls[2]?.body).toMatchObject({ text: 'What folders are in the workspace?' });
      }
    }
  );

  it('does not submit a prompt when saving its instructions fails', async () => {
    const wire = vi.fn(async (method: string) => {
      if (method === 'PUT') throw new Error('Instruction update failed');
      return { data: { id: 'ses_workspace' } };
    });
    const adapter = new OpenCodeV2Adapter(wire);
    await expect(
      adapter.request('POST', '/session/ses_workspace/prompt_async', {
        system: 'Workspace roots: /repo-a, /repo-b',
        parts: [{ type: 'text', text: 'List the workspace roots' }],
      })
    ).rejects.toThrow('Instruction update failed');
    expect(wire.mock.calls.map(([method]) => method)).toEqual(['GET', 'PUT']);
  });
});

describe('v2 model release dates', () => {
  const model: ModelInfo = {
    id: 'model',
    modelID: 'model',
    providerID: 'provider',
    name: 'Model',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [],
    time: { released: Date.parse('2026-09-17T12:00:00Z') },
    cost: [],
    status: 'active',
    enabled: true,
    limit: { context: 400_000, output: 32_000 },
  };

  it('projects the native timestamp into the release date used by model ordering and display', () => {
    expect(projectV2Model(model).release_date).toBe('2026-09-17');
  });

  it.each([0, -1, NaN, Infinity, 1e20])(
    'omits unknown or invalid release timestamps: %s',
    (released) => {
      expect(projectV2Model({ ...model, time: { released } }).release_date).toBeUndefined();
    }
  );
});

describe('OpenCode connection discovery', () => {
  it('recognizes supported families without relying on the binary name', () => {
    expect(openCodeApiVersion('opencode v2.0.5')).toBe(2);
    expect(openCodeApiVersion('1.18.31')).toBe(1);
    expect(openCodeApiVersion('3.0.0')).toBeNull();
  });

  it('captures and redacts passwords at every chunk boundary', () => {
    const bytes = Buffer.from('listening\nserver password private-password\nready\n');
    for (let split = 1; split < bytes.length; split++) {
      const passwords: string[] = [];
      const reader = new OpenCodeStartupOutput((password) => passwords.push(password));
      const first = reader.write(bytes.subarray(0, split));
      const second = reader.write(bytes.subarray(split));
      expect(Buffer.concat([first, second]).toString()).toBe(
        'listening\nserver password [redacted]\nready\n'
      );
      expect(passwords).toEqual(['private-password']);
    }
  });

  it('keeps large ordinary output undecoded and drops oversized credential lines', () => {
    const capture = vi.fn();
    const reader = new OpenCodeStartupOutput(capture);
    const bulk = Buffer.alloc(1024 * 1024, 'x');
    expect(reader.write(bulk)).toBe(bulk);
    const text = Buffer.concat([
      reader.write(Buffer.from(`server password ${'secret'.repeat(3000)}`)),
      reader.write(Buffer.from('more-secret\nready\n')),
    ]).toString();
    expect(text).toBe('server password [redacted]\nready\n');
    expect(capture).not.toHaveBeenCalled();
  });

  it.each(['/api/status', '/api/info'])(
    'detects v2 behind HTML fallback and authenticates translated requests using %s',
    async (healthPath) => {
      const calls: Array<{ url: string; headers: Headers }> = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        calls.push({ url, headers: new Headers(init.headers) });
        const path = new URL(url).pathname;
        if (path === '/global/health')
          return new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } });
        if (path === healthPath) return Response.json({ version: '2.0.5', pid: 123, urls: [] });
        if (path === '/api/status') return new Response('', { status: 404 });
        if (path === '/api/session/active')
          return Response.json({ data: { ses_busy: { type: 'running' } } });
        throw new Error(`Unexpected request: ${path}`);
      });
      const transport = new OpenCodeTransport({
        getUrl: () => 'http://localhost:4096',
        getWorkspaceCwd: () => '/workspace',
        getStatus: () => ({ state: 'stopped' }),
        isDisposing: () => false,
        updateEventStreamState: () => {},
        emitEvent: () => {},
        getAuthorization: () => 'Basic fixture',
      });
      expect(await transport.readHealthInfo()).toEqual({ healthy: true, version: '2.0.5' });
      expect(parseHealthResponse(await transport.request('GET', '/global/health'))).toEqual({
        healthy: true,
        version: '2.0.5',
      });
      expect(calls.at(-1)?.url).toBe(`http://localhost:4096${healthPath}`);
      expect(await transport.request('GET', '/session/status')).toEqual({
        ses_busy: { type: 'busy' },
      });
      expect(calls.every((call) => call.headers.get('authorization') === 'Basic fixture')).toBe(
        true
      );
      await expect(transport.request('GET', 'https://example.com/session')).rejects.toThrow(
        'Unsupported OpenCode API path'
      );
      expect(calls).toHaveLength(healthPath === '/api/status' ? 4 : 6);
    }
  );

  it('cancels an in-flight v2 webview health request when the transport stops', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      new URL(url).pathname === '/api/status'
        ? Response.json({ version: '2.0.5', pid: 123, urls: [] })
        : new Response('', { status: 404 })
    );
    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => undefined,
      getStatus: () => ({ state: 'stopped' }),
      isDisposing: () => false,
      updateEventStreamState: () => {},
      emitEvent: () => {},
    });
    expect((await transport.readHealthInfo()).healthy).toBe(true);
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    );
    const pending = transport.request('GET', '/global/health');
    const rejected = expect(pending).rejects.toThrow();
    transport.abortRequests();
    await rejected;
    await transport.waitForRequestsToSettle();
  });

  it('distinguishes failed authentication from a startup timeout', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => undefined,
      getStatus: () => ({ state: 'stopped' }),
      isDisposing: () => false,
      updateEventStreamState: () => {},
      emitEvent: () => {},
    });
    expect(await transport.readHealthInfo()).toEqual({ healthy: false });
    expect(transport.healthError).toContain('authentication failed');
  });
});

describe('v2 transcript and permission projection', () => {
  it('normalizes description-less native commands for slash-command search', async () => {
    const adapter = new OpenCodeV2Adapter(async (_method, path) =>
      path.startsWith('/api/config')
        ? [{ type: 'document', info: { commands: { local: { template: 'Local prompt' } } } }]
        : { data: [{ name: 'inspect' }, { name: 'explain', description: 'Explain this code' }] }
    );
    expect(await adapter.request('GET', '/command', undefined)).toEqual([
      { name: 'inspect', description: '', template: '', hints: [] },
      { name: 'explain', description: 'Explain this code', template: '', hints: [] },
      { name: 'local', description: '', template: 'Local prompt', hints: [] },
    ]);
  });
  const message: SessionMessageAssistant = {
    id: 'msg_assistant',
    type: 'assistant',
    time: { created: 10, completed: 20 },
    agent: 'build',
    model: { id: 'model', providerID: 'provider' },
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'reasoning', text: 'Thinking' },
      {
        type: 'tool',
        id: 'tool_call',
        name: 'shell',
        state: {
          status: 'completed',
          input: { command: 'pwd' },
          content: [
            { type: 'text', text: '/workspace' },
            { type: 'file', uri: 'file:///workspace/output.png', mime: 'image/png' },
          ],
          metadata: { title: 'Working directory' },
        },
        time: { created: 11, ran: 12, completed: 15 },
      },
    ],
  };

  it('uses the same part identities for history and incremental events', () => {
    const history = projectV2Message(message, 'ses_one');
    const text = parseServerEvent(
      projectV2Event({
        id: 'evt_text',
        created: 10,
        type: 'session.text.delta',
        data: { sessionID: 'ses_one', assistantMessageID: message.id, ordinal: 0, delta: 'Hello' },
      })[0]
    );
    expect(asRecord(text?.properties)?.textID).toBe(history.parts[0]?.id);
    const reasoning = parseServerEvent(
      projectV2Event({
        id: 'evt_reasoning',
        created: 10,
        type: 'session.reasoning.delta',
        data: {
          sessionID: 'ses_one',
          assistantMessageID: message.id,
          ordinal: 0,
          delta: 'Thinking',
        },
      })[0]
    );
    expect(asRecord(reasoning?.properties)?.reasoningID).toBe(history.parts[1]?.id);
    expect(asRecord(reasoning?.properties)?.reasoningID).not.toBe(
      asRecord(text?.properties)?.textID
    );
    expect(history.parts[2]).toMatchObject({
      id: 'tool_call',
      callID: 'tool_call',
      tool: 'bash',
      state: {
        status: 'completed',
        title: 'Working directory',
        output: '/workspace',
        time: { start: 12, end: 15 },
        attachments: [{ url: 'file:///workspace/output.png' }],
      },
    });
  });

  it.each(['started', 'delta', 'ended'])(
    'matches type-local ordinals for interleaved text and reasoning %s events',
    (phase) => {
      const interleaved: SessionMessageAssistant = {
        ...message,
        content: [
          { type: 'reasoning', text: 'Inspecting' },
          message.content[2]!,
          { type: 'text', text: '' },
          { type: 'reasoning', text: 'Checked' },
          { type: 'text', text: 'Final answer' },
        ],
      };
      const history = projectV2Message(interleaved, 'ses_one');
      const identities: unknown[] = [];
      for (const [type, ordinal, index] of [
        ['reasoning', 0, 0],
        ['text', 0, 2],
        ['reasoning', 1, 3],
        ['text', 1, 4],
      ] as const) {
        const event = parseServerEvent(
          projectV2Event({
            id: `evt_${type}_${ordinal}`,
            created: 10,
            type: `session.${type}.${phase}`,
            data: {
              sessionID: 'ses_one',
              assistantMessageID: message.id,
              ordinal,
              delta: 'chunk',
              text: 'Final answer',
            },
          })[0]
        );
        const id = asRecord(event?.properties)?.[`${type}ID`];
        expect(id).toBe(history.parts[index]?.id);
        identities.push(id);
      }
      expect(new Set(identities).size).toBe(4);
    }
  );

  it('leaves untitled shell calls available for the command-preview fallback', () => {
    const untitled: SessionMessageAssistant = {
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool' ? { ...part, state: { ...part.state, metadata: {} } } : part
      ),
    };
    const projected = projectV2Message(untitled, 'ses_one');
    expect(projected.parts[2]).toMatchObject({
      tool: 'bash',
      state: { input: { command: 'pwd' }, title: undefined },
    });
  });

  it('resolves an assistant parent outside the requested page without changing page identity', async () => {
    const adapter = new OpenCodeV2Adapter(async (_method, path) => {
      if (path.endsWith('/inbox')) return { data: [] };
      const url = new URL(path, 'http://localhost');
      return url.searchParams.get('cursor') === 'older'
        ? {
            data: [
              {
                id: 'msg_user',
                type: 'user',
                text: 'Hi',
                time: { created: 1 },
                files: [],
                agents: [],
                skills: [],
              },
            ],
            cursor: {},
          }
        : { data: [message], cursor: { next: 'older' } };
    });
    const page = asRecord(
      await adapter.request('GET', '/session/ses_one/message?limit=1', undefined, {
        captureNextCursor: true,
      })
    );
    expect(page?.data).toHaveLength(1);
    expect(page?.data).toMatchObject([{ info: { id: 'msg_assistant', parentID: 'msg_user' } }]);
    expect(page?.nextCursor).toBe('older');
  });

  it('preserves action rules, ordering, and child request ownership', () => {
    expect(
      v2Rules([
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'task', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: 'git push *', action: 'ask' },
      ])
    ).toEqual([
      { action: '*', resource: '*', effect: 'ask' },
      { action: 'subagent', resource: '*', effect: 'allow' },
      { action: 'shell', resource: 'git push *', effect: 'ask' },
    ]);
    expect(v2Action('toString')).toBe('toString');
    expect(
      projectV2Permission({
        id: 'perm_one',
        sessionID: 'ses_child',
        action: 'shell',
        resources: ['git push'],
        source: { type: 'tool', messageID: 'msg_child', id: 'call_child' },
      })
    ).toMatchObject({
      id: 'perm_one',
      sessionID: 'ses_child',
      permission: 'bash',
      tool: { messageID: 'msg_child', callID: 'call_child' },
    });
    expect(() => v2Rules([{ permission: '*', pattern: '*', action: 'invalid' }])).toThrow(
      'Invalid OpenCode permission rule'
    );
  });

  it('preserves sequence accounting and waits for the execution boundary', () => {
    const ended = parseServerEvent(
      projectV2Event({
        id: 'evt_one',
        created: 50,
        type: 'session.step.ended',
        durable: { seq: 7 },
        location: { directory: '/repo' },
        data: { sessionID: 'ses_one', assistantMessageID: 'msg_one', finish: 'stop' },
      })[0]
    );
    expect(ended).toMatchObject({
      type: 'session.next.step.ended',
      seq: 7,
      workspaceDirectory: '/repo',
      properties: { executionContinues: true },
    });
    const idle = parseServerEvent(
      projectV2Event({
        id: 'evt_two',
        created: 51,
        type: 'session.execution.succeeded',
        durable: { seq: 8 },
        data: { sessionID: 'ses_one' },
      })[0]
    );
    expect(idle).toMatchObject({
      type: 'session.status',
      seq: 8,
      properties: { status: { type: 'idle' } },
    });
    const unknown = parseServerEvent(
      projectV2Event({
        id: 'evt_three',
        type: 'session.future.event',
        durable: { seq: 9 },
        data: { sessionID: 'ses_one' },
      })[0]
    );
    expect(unknown).toMatchObject({ sequenceOnly: true, seq: 9 });
  });

  it('delivers execution failures before idle and advances the durable sequence once', () => {
    const events = projectV2Event(
      {
        id: 'evt_failed',
        created: 20,
        type: 'session.execution.failed',
        durable: { seq: 8 },
        data: {
          sessionID: 'ses_one',
          error: { type: 'api', message: 'Provider failed', status: 503 },
        },
      },
      { hasAssistant: true }
    ).map(parseServerEvent);
    expect(events[0]).toMatchObject({
      type: 'session.error',
      seq: 8,
      properties: { error: { data: { message: 'Provider failed', statusCode: 503 } } },
    });
    expect(events[1]).toMatchObject({
      type: 'session.status',
      properties: { status: { type: 'idle' } },
    });
    expect(events[1]?.seq).toBeUndefined();
  });

  it('creates an error row before reporting a pre-turn authentication failure', () => {
    const events = projectV2Event(
      {
        id: 'evt_failed',
        created: 20,
        type: 'session.execution.failed',
        durable: { seq: 8 },
        data: { sessionID: 'ses_one', error: { type: 'unknown', message: 'Request failed: 401' } },
      },
      { agent: 'build', model: { providerID: 'openai', id: 'model' }, parentID: 'msg_user' }
    ).map(parseServerEvent);
    expect(events[0]).toMatchObject({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_failed',
          parentID: 'msg_user',
          role: 'assistant',
          providerID: 'openai',
          error: { data: { statusCode: 401 } },
        },
      },
    });
    expect(events[1]).toMatchObject({ type: 'session.error', seq: 8 });
    expect(events[2]).toMatchObject({
      type: 'session.status',
      properties: { status: { type: 'idle' } },
    });
    expect(events.filter((event) => event?.seq !== undefined)).toHaveLength(1);
  });

  it('paginates past internal instructions without exposing user bubbles', async () => {
    const wire = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/inbox')) return { data: [] };
      const cursor = new URL(path, 'http://localhost').searchParams.get('cursor');
      if (!cursor)
        return {
          data: [
            {
              id: 'msg_catalog',
              type: 'system',
              text: 'The Code Mode tool catalog has changed.',
              time: { created: 3 },
            },
            {
              id: 'msg_restart',
              type: 'synthetic',
              text: 'The server restarted while you were working.',
              time: { created: 2 },
            },
          ],
          cursor: { next: 'older' },
        };
      expect(cursor).toBe('older');
      return {
        data: [{ id: 'msg_user', type: 'user', text: 'Continue', time: { created: 1 } }],
        cursor: {},
      };
    });
    const adapter = new OpenCodeV2Adapter(wire);
    const page = await adapter.request('GET', '/session/ses_one/message?limit=2', undefined, {
      captureNextCursor: true,
    });
    expect(page).toMatchObject({
      data: [{ info: { id: 'msg_user', role: 'user' }, parts: [{ text: 'Continue' }] }],
      nextCursor: undefined,
    });
    expect(asRecord(page)?.data).toHaveLength(1);
    expect(wire).toHaveBeenCalledTimes(3);
  });

  it('hides v2 control records and retains failures when history is reopened', async () => {
    const records = [
      { id: 'msg_failed', type: 'idle', outcome: 'failed', time: { created: 4 } },
      {
        id: 'msg_user',
        type: 'user',
        text: 'Test message',
        time: { created: 3 },
        files: [],
        agents: [],
        skills: [],
      },
      {
        id: 'msg_model',
        type: 'model-switched',
        model: { providerID: 'openai', id: 'model' },
        time: { created: 2 },
      },
      { id: 'msg_agent', type: 'agent-switched', agent: 'build', time: { created: 1 } },
    ];
    const wire = async (_method: string, path: string) => ({
      data: path.endsWith('/inbox') ? [] : records,
      cursor: {},
    });
    const adapter = new OpenCodeV2Adapter(wire);
    adapter.observe(
      'session.execution.failed',
      { sessionID: 'ses_one', error: { type: 'unknown', message: 'Request failed: 401' } },
      'evt_failed'
    );
    const messages = await adapter.request('GET', '/session/ses_one/message', undefined);
    expect(messages).toMatchObject([
      {
        info: {
          id: 'msg_user',
          role: 'user',
          agent: 'build',
          model: { providerID: 'openai', modelID: 'model' },
        },
        parts: [{ text: 'Test message' }],
      },
      {
        info: {
          id: 'msg_failed',
          role: 'assistant',
          parentID: 'msg_user',
          error: { data: { statusCode: 401, message: 'Request failed: 401' } },
        },
      },
    ]);
    expect(messages).toHaveLength(2);
    const reopened = await new OpenCodeV2Adapter(wire).request(
      'GET',
      '/session/ses_one/message',
      undefined
    );
    expect(reopened).toMatchObject([
      { info: { id: 'msg_user' } },
      {
        info: {
          id: 'msg_failed',
          error: { data: { message: expect.stringContaining('Check the provider connection') } },
        },
      },
    ]);
    expect(reopened).toHaveLength(2);
  });

  it('keeps a cached authentication failure attached to its original provider', async () => {
    const adapter = new OpenCodeV2Adapter(async (_method, path) => ({
      data: path.endsWith('/inbox')
        ? []
        : [{ id: 'msg_failed', type: 'idle', outcome: 'failed', time: { created: 4 } }],
      cursor: {},
    }));
    adapter.observe('session.model.selected', {
      sessionID: 'ses_one',
      model: { providerID: 'openai', id: 'original' },
    });
    adapter.observe(
      'session.execution.failed',
      { sessionID: 'ses_one', error: { type: 'unknown', message: 'Request failed: 401' } },
      'evt_failed'
    );
    adapter.observe('session.model.selected', {
      sessionID: 'ses_one',
      model: { providerID: 'different', id: 'recovery' },
    });
    expect(
      await adapter.request('GET', '/session/ses_one/message?limit=1', undefined)
    ).toMatchObject([
      {
        info: {
          providerID: 'openai',
          modelID: 'original',
          error: { data: { providerID: 'openai', statusCode: 401 } },
        },
      },
    ]);
  });

  it('maps v2 provider updates to a recognized catalog event', () => {
    expect(
      parseServerEvent(
        projectV2Event({ id: 'evt_provider', type: 'provider.updated', data: {} })[0]
      )?.type
    ).toBe('catalog.updated');
  });

  it('does not discard requests when the server rejects the reply', async () => {
    const calls: string[] = [];
    const adapter = new OpenCodeV2Adapter(async (_method, path, body) => {
      calls.push(path);
      if (path.endsWith('/reply')) {
        expect(body).toEqual({ decision: 'once', message: undefined });
        throw new Error('503 busy');
      }
      throw new Error('Unexpected snapshot request');
    });
    adapter.observe('permission.asked', { id: 'perm_one', sessionID: 'ses_child' });
    await expect(
      adapter.request('POST', '/permission/perm_one/reply', { reply: 'once' })
    ).rejects.toThrow('503 busy');
    await expect(
      adapter.request('POST', '/permission/perm_one/reply', { reply: 'once' })
    ).rejects.toThrow('503 busy');
    expect(calls).toEqual([
      '/api/session/ses_child/permission/perm_one/reply',
      '/api/session/ses_child/permission/perm_one/reply',
    ]);
  });

  it('uses native OAuth attempts for MCP authentication and waits for completion', async () => {
    const opened = vi.fn(async () => true);
    const adapter = new OpenCodeV2Adapter(
      async (method, path, body) => {
        const route = new URL(path, 'http://localhost').pathname;
        if (route === '/api/mcp')
          return { data: [{ name: 'fixture', integrationID: 'fixture-integration' }] };
        if (route === '/api/integration/fixture-integration')
          return { data: { methods: [{ id: 'login', type: 'oauth', label: 'Sign in' }] } };
        if (route.endsWith('/connect/oauth') && method === 'POST') {
          expect(body).toMatchObject({ methodID: 'login' });
          return {
            data: {
              attemptID: 'attempt-one',
              url: 'https://example.com/fixture-auth',
              mode: 'auto',
              instructions: 'Sign in',
            },
          };
        }
        if (route.endsWith('/connect/oauth/attempt-one')) return { data: { status: 'complete' } };
        throw new Error(`Unexpected OAuth request ${method} ${route}`);
      },
      undefined,
      opened
    );
    expect(await adapter.request('POST', '/mcp/fixture/auth/authenticate', {})).toBe(true);
    expect(opened).toHaveBeenCalledWith('https://example.com/fixture-auth');
  });

  it('persists host annotations without issuing unsupported native patches', async () => {
    const parent = resolve('artifacts/ai-test-data');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'annotations-'));
    const session: SessionInfo = {
      id: 'ses_local',
      title: 'Original',
      projectID: 'project',
      location: { directory: '/repo' },
      time: { created: 1, updated: 2 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const wire = vi.fn(async () => ({ data: session }));
    const state = new OpenCodeV2SessionState(directory);
    const adapter = new OpenCodeV2Adapter(wire, state);
    expect(
      normalizeRecycleBinSession(await adapter.request('GET', '/session/ses_local', undefined))
    ).toMatchObject({
      id: session.id,
      directory: '/repo',
      version: '2',
    });
    wire.mockClear();
    const metadata = { varro: { permissionMode: 'auto' } };
    await adapter.request('PATCH', '/session/ses_local', { metadata });
    expect(wire.mock.calls).toHaveLength(1);
    expect(
      asRecord(
        await new OpenCodeV2Adapter(wire, new OpenCodeV2SessionState(directory)).request(
          'GET',
          '/session/ses_local',
          undefined
        )
      )?.metadata
    ).toEqual(metadata);
    expect(JSON.parse(await readFile(join(directory, 'ses_local.json'), 'utf8'))).toMatchObject({
      metadata,
    });
    await expect(state.read('../escape')).rejects.toThrow('Could not read');
  });
});
