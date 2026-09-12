/* oxlint-disable anti-slop/no-unknown-parameters -- Fake OpenCode requests decode protocol-shaped test bodies. */
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../shared/opencode-types';
import { asRecord } from '../shared/type-utils';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
} from './sidebar-provider.test-support';

describe('session selection metadata', () => {
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
      varro: { workspaceScope: 'folder' },
      varroModel: model,
      varroAgent: 'plan',
      varroPermissionMode: 'auto',
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
    expect(session.metadata?.varroModel).toEqual(modelWithoutVariant);
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
          metadata: { ...session.metadata, varroAgent: 'build' },
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
