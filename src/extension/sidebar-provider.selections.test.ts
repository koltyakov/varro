/* oxlint-disable anti-slop/no-unknown-parameters -- Fake OpenCode requests decode protocol-shaped test bodies. */
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../shared/opencode-types';
import { asRecord } from '../shared/type-utils';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  createStoredWorkspaceState,
  createWorkspaceState,
} from './sidebar-provider.test-support';

describe('session selection metadata', () => {
  it('broadcasts a committed pin after its API caller cancels', async () => {
    const workspaceState = createWorkspaceState();
    const update = workspaceState.update;
    let finishWrite: (() => void) | undefined;
    workspaceState.update = vi.fn(async (key: string, value: unknown) => {
      if (key === 'varro.pinnedSessionIds') {
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
      }
      await update(key, value);
    });
    const server = createServer({
      request: vi.fn(async () => ({ id: 'session-1', directory: '/repo' })),
    });
    const { provider } = await createSidebarProviderInstance({ workspaceState, server });
    const { posted } = attachTestView(provider);
    const pending = provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 1,
        cancelKey: 'pin-request',
        method: 'POST',
        path: '/varro/session/session-1/pin',
        body: { pinned: true },
      },
    });
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    expect(posted.some((message) => asRecord(message)?.type === 'pinned-sessions/sync')).toBe(
      false
    );
    await provider.handleMessage({
      type: 'api/cancel',
      payload: { id: 1, cancelKey: 'pin-request' },
    });
    finishWrite?.();
    await pending;
    expect(posted.filter((message) => asRecord(message)?.type === 'pinned-sessions/sync')).toEqual([
      { type: 'pinned-sessions/sync', payload: { sessionIds: ['session-1'] } },
    ]);
    expect(workspaceState.update).toHaveBeenCalledWith('varro.pinnedSessionIds', ['session-1']);
  });

  it('keeps a todo mark until a later prompt reaches the session', async () => {
    const workspaceState = createStoredWorkspaceState(new Map());
    const server = createServer({
      request: vi.fn(async () => ({ id: 'session-1', directory: '/repo' })),
    });
    const { provider } = await createSidebarProviderInstance({ workspaceState, server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 1,
        method: 'POST',
        path: '/varro/session/session-1/todo',
        body: { todo: true },
      },
    });
    const todoSyncs = () =>
      posted.filter((message) => asRecord(message)?.type === 'todo-sessions/sync');
    await vi.waitFor(() =>
      expect(todoSyncs()).toEqual([
        { type: 'todo-sessions/sync', payload: { sessionIds: ['session-1'] } },
      ])
    );
    const markedAt = asRecord(workspaceState.get('varro.todoSessions'))?.['session-1'];
    expect(markedAt).toEqual(expect.any(Number));

    const eventHandler = server.on.mock.calls.find(([event]) => event === 'event')?.[1];
    const userMessage = (created: number) => ({
      type: 'message.updated',
      properties: {
        info: { id: `msg-${created}`, sessionID: 'session-1', role: 'user', time: { created } },
      },
    });
    // Replayed history from before the mark must not clear it.
    eventHandler?.(userMessage(Number(markedAt) - 1));
    await Promise.resolve();
    expect(todoSyncs()).toHaveLength(1);

    eventHandler?.(userMessage(Number(markedAt) + 1));
    await vi.waitFor(() =>
      expect(todoSyncs().at(-1)).toEqual({
        type: 'todo-sessions/sync',
        payload: { sessionIds: [] },
      })
    );
    expect(workspaceState.get('varro.todoSessions')).toEqual({});
  });

  it('acknowledges each rapid agent switch with its originating selection id', async () => {
    let metadata = {};
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'PATCH') metadata = asRecord(asRecord(body)?.metadata) ?? {};
      return { id: 'session-1', directory: '/repo', metadata };
    });
    const { provider } = await createSidebarProviderInstance({ server: createServer({ request }) });
    const { posted } = attachTestView(provider);
    const selections = ['ask', 'build', 'ask', 'build'].map((agent, index) => ({
      sessionId: 'session-1',
      agent,
      selectionId: `selection-${index}`,
    }));
    await Promise.all(
      selections.map((payload) =>
        provider.handleMessage({ type: 'session-plan-state/update', payload })
      )
    );
    expect(
      posted.filter((message) => asRecord(message)?.type === 'session-plan-state/update')
    ).toEqual(selections.map((payload) => ({ type: 'session-plan-state/update', payload })));
    expect(asRecord(asRecord(metadata)?.varro)?.agent).toBe('build');
  });

  it('settles a failed agent selection without publishing it as confirmed', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'PATCH') throw new Error('metadata unavailable');
      return { id: 'session-1', directory: '/repo' };
    });
    const { provider } = await createSidebarProviderInstance({ server: createServer({ request }) });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', agent: 'build', selectionId: 'selection-4' },
    });
    expect(
      posted.filter((message) => asRecord(message)?.type === 'session-plan-state/update')
    ).toEqual([
      {
        type: 'session-plan-state/update',
        payload: { sessionId: 'session-1', selectionId: 'selection-4' },
      },
    ]);
  });

  it('does not restore an older in-flight session response over a confirmed model selection', async () => {
    let session: Session = {
      id: 'session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Shared session',
      version: '1',
      time: { created: 1, updated: 2 },
      metadata: { varro: { model: { provider: 'openai', model: 'old-model' } } },
    };
    const oldSession = session;
    let finishRead: ((value: Session) => void) | undefined;
    const delayedRead = new Promise<Session>((resolve) => {
      finishRead = resolve;
    });
    let delayNextRead = true;
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET' && delayNextRead) {
        delayNextRead = false;
        return delayedRead;
      }
      if (method === 'PATCH')
        session = {
          ...session,
          metadata: asRecord(asRecord(body)?.metadata) ?? {},
          time: { created: 1, updated: 3 },
        };
      return session;
    });
    const server = createServer({ request });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const pending = provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/session/session-1' },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const model = { providerID: 'openai', modelID: 'new-model' };
    await provider.handleMessage({
      type: 'session-model/update',
      payload: { sessionId: 'session-1', model, selectionId: 'model-selection-1' },
    });
    finishRead?.(oldSession);
    await pending;
    expect(
      posted.filter((message) => asRecord(message)?.type === 'session-models/sync').at(-1)
    ).toEqual({
      type: 'session-models/sync',
      payload: {
        models: { 'session-1': model },
        acknowledgement: { sessionId: 'session-1', selectionId: 'model-selection-1' },
      },
    });
    // A later authoritative change from another client must still be restored.
    session = { ...oldSession, time: { created: 1, updated: 4 } };
    const eventHandler = server.on.mock.calls.find(([event]) => event === 'event')?.[1];
    eventHandler?.({ type: 'session.updated', properties: { info: session } });
    expect(
      posted.filter((message) => asRecord(message)?.type === 'session-models/sync').at(-1)
    ).toEqual({
      type: 'session-models/sync',
      payload: { models: { 'session-1': { providerID: 'openai', modelID: 'old-model' } } },
    });
  });

  it('serializes model, reasoning, agent and permission writes and restores another instance read-only', async () => {
    let session: Session = {
      id: 'session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'Shared session',
      version: '1',
      time: { created: 1, updated: 2 },
      metadata: { custom: 'preserved', varro: { workspaceScope: 'folder' } },
    };
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'PATCH') {
        session = { ...session, metadata: asRecord(asRecord(body)?.metadata) ?? {} };
      }
      return path.startsWith('/session?') ? [session] : session;
    });
    const first = await createSidebarProviderInstance({ server: createServer({ request }) });
    attachTestView(first.provider);
    const model = { providerID: 'openai', modelID: 'test-model', variant: 'high' };
    await Promise.all([
      first.provider.handleMessage({
        type: 'session-model/update',
        payload: { sessionId: session.id, model },
      }),
      first.provider.handleMessage({
        type: 'session-plan-state/update',
        payload: { sessionId: session.id, agent: 'plan' },
      }),
      first.provider.handleMessage({
        type: 'api/request',
        payload: {
          id: 1,
          method: 'POST',
          path: '/varro/session/session-1/permission-mode',
          body: { mode: 'auto' },
        },
      }),
    ]);
    expect(session.metadata).toEqual({
      custom: 'preserved',
      varro: {
        schemaVersion: 1,
        workspaceScope: 'folder',
        model: { provider: 'openai', model: 'test-model', variant: 'high' },
        agent: 'plan',
        permissionMode: 'auto',
      },
    });
    const secondServer = createServer({ request });
    const second = await createSidebarProviderInstance({ server: secondServer });
    const { posted } = attachTestView(second.provider);
    request.mockClear();
    await second.provider.handleMessage({
      type: 'api/request',
      payload: {
        id: 2,
        method: 'GET',
        path: '/session/session-1',
      },
    });
    expect(posted).toContainEqual({
      type: 'session-models/sync',
      payload: { models: { 'session-1': model } },
    });
    expect(posted).toContainEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', agent: 'plan' },
    });
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    expect(session.time.updated).toBe(2);

    // Replacing the complete model selection must also remove an old reasoning variant.
    const modelWithoutVariant = { providerID: 'openai', modelID: 'test-model' };
    await first.provider.handleMessage({
      type: 'session-model/update',
      payload: { sessionId: session.id, model: modelWithoutVariant },
    });
    expect(asRecord(session.metadata?.varro)?.model).toEqual({
      provider: 'openai',
      model: 'test-model',
    });
    request.mockClear();
    await first.provider.handleMessage({
      type: 'session-model/update',
      payload: { sessionId: session.id, model: modelWithoutVariant },
    });
    await first.provider.handleMessage({
      type: 'session-plan-state/update',
      payload: { sessionId: session.id, agent: 'plan' },
    });
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    const eventHandler = secondServer.on.mock.calls.find(([event]) => event === 'event')?.[1];
    eventHandler?.({
      type: 'session.updated',
      properties: {
        info: {
          ...session,
          metadata: {
            ...session.metadata,
            varro: { ...asRecord(session.metadata?.varro), agent: 'build' },
          },
        },
      },
    });
    expect(posted).toContainEqual({
      type: 'session-models/sync',
      payload: { models: { 'session-1': modelWithoutVariant } },
    });
    expect(posted).toContainEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', agent: 'build' },
    });
  });

  it('does not publish confirmed selections after a failed metadata write', async () => {
    const server = createServer({
      request: vi.fn(async (method: string) => {
        if (method === 'PATCH') throw new Error('metadata unavailable');
        return { id: 'session-1' };
      }),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    await provider.handleMessage({
      type: 'session-model/update',
      payload: {
        sessionId: 'session-1',
        model: { providerID: 'openai', modelID: 'test-model', variant: 'high' },
      },
    });
    await provider.handleMessage({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', agent: 'plan' },
    });
    expect(posted).not.toContainEqual(expect.objectContaining({ type: 'session-models/sync' }));
    expect(posted).not.toContainEqual(
      expect.objectContaining({ type: 'session-plan-state/update' })
    );
  });
});
